import type { AlertRule, AlertEvent, AlertSeverity } from '../../types/alerts';

/**
 * Alert evaluator with deduplication and storm control.
 *
 * Responsibilities:
 *  - Hysteresis/cooldown: a single threshold crossing yields one alert even
 *    when the value oscillates around the threshold.
 *  - Cross-tab coordination: an alert fires exactly once per origin via the
 *    broadcast channel.
 *  - Storm budget: bursts beyond a rate are coalesced into a summary, while
 *    genuinely distinct alerts are never suppressed.
 */

export interface EvaluatorOptions {
  /** Value must move back past threshold by this margin before re-arming. */
  hysteresis?: number;
  /** Minimum ms between two fires of the same alert identity. */
  cooldownMs?: number;
  /** Max distinct alerts allowed within the window before coalescing. */
  stormBudget?: number;
  /** Sliding window (ms) used for the storm budget. */
  stormWindowMs?: number;
  /** Broadcast channel used to coordinate across tabs. */
  channel?: BroadcastChannel | null;
  /** Unique id for this tab/origin so we can dedupe cross-tab deliveries. */
  originId?: string;
  /** Clock injection for tests. */
  now?: () => number;
}

interface RuleState {
  /** Whether the rule is currently considered "fired" (armed = can fire). */
  armed: boolean;
  /** Timestamp of the last fire for this identity. */
  lastFiredAt: number;
}

interface StormEntry {
  identity: string;
  at: number;
}

const DEFAULTS = {
  hysteresis: 0,
  cooldownMs: 0,
  stormBudget: Infinity,
  stormWindowMs: 60_000,
};

/**
 * Build a stable identity for an alert so dedupe is on identity, not count.
 * Distinct rules / severities / sources remain distinct alerts.
 */
export function alertIdentity(rule: AlertRule, severity: AlertSeverity): string {
  return [rule.id, rule.source ?? 'default', severity].join('::');
}

export class AlertEvaluator {
  private readonly opts: Required<Omit<EvaluatorOptions, 'channel' | 'originId'>> &
    Pick<EvaluatorOptions, 'channel' | 'originId'>;
  private readonly ruleState = new Map<string, RuleState>();
  private readonly stormLog: StormEntry[] = [];
  private readonly seenRemote = new Set<string>();

  constructor(options: EvaluatorOptions = {}) {
    this.opts = {
      hysteresis: options.hysteresis ?? DEFAULTS.hysteresis,
      cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
      stormBudget: options.stormBudget ?? DEFAULTS.stormBudget,
      stormWindowMs: options.stormWindowMs ?? DEFAULTS.stormWindowMs,
      now: options.now ?? (() => Date.now()),
      channel: options.channel ?? null,
      originId: options.originId,
    };

    if (this.opts.channel) {
      this.opts.channel.addEventListener('message', this.onBroadcast);
    }
  }

  dispose(): void {
    if (this.opts.channel) {
      this.opts.channel.removeEventListener('message', this.onBroadcast);
    }
  }

  /**
   * Evaluate a rule against the current value. Returns the alert to deliver,
   * a coalesced summary, or null when suppressed.
   */
  evaluate(rule: AlertRule, value: number, severity: AlertSeverity = 'warning'): AlertEvent | null {
    const now = this.opts.now();
    const identity = alertIdentity(rule, severity);
    const state = this.ruleState.get(identity) ?? { armed: true, lastFiredAt: 0 };

    const crossed = this.hasCrossed(rule, value);
    const rearmed = this.hasRearmed(rule, value);

    if (rearmed) {
      state.armed = true;
    }

    // Hysteresis: only fire on a fresh crossing while armed.
    if (!crossed || !state.armed) {
      this.ruleState.set(identity, state);
      return null;
    }

    // Cooldown: suppress rapid re-fires of the same identity.
    if (now - state.lastFiredAt < this.opts.cooldownMs) {
      this.ruleState.set(identity, state);
      return null;
    }

    // Cross-tab coordination: if another tab already delivered this identity
    // within the cooldown window, do not deliver again.
    if (this.seenRemote.has(identity)) {
      this.seenRemote.delete(identity);
      state.armed = false;
      this.ruleState.set(identity, state);
      return null;
    }

    state.armed = false;
    state.lastFiredAt = now;
    this.ruleState.set(identity, state);

    const event: AlertEvent = {
      identity,
      ruleId: rule.id,
      source: rule.source ?? 'default',
      severity,
      value,
      threshold: rule.threshold,
      firedAt: now,
    };

    // Storm budget: coalesce bursts beyond the rate into a summary, but never
    // drop a genuinely distinct alert.
    const summary = this.applyStormBudget(event, now);
    if (summary) {
      return summary;
    }

    this.broadcast(event);
    return event;
  }

  private hasCrossed(rule: AlertRule, value: number): boolean {
    if (rule.direction === 'below') {
      return value <= rule.threshold;
    }
    return value >= rule.threshold;
  }

  private hasRearmed(rule: AlertRule, value: number): boolean {
    const margin = this.opts.hysteresis;
    if (rule.direction === 'below') {
      return value > rule.threshold + margin;
    }
    return value < rule.threshold - margin;
  }

  /**
   * Track distinct alerts in the sliding window. When the budget is exceeded,
   * return a single coalesced summary event instead of individual deliveries.
   */
  private applyStormBudget(event: AlertEvent, now: number): AlertEvent | null {
    const windowStart = now - this.opts.stormWindowMs;
    while (this.stormLog.length && this.stormLog[0].at < windowStart) {
      this.stormLog.shift();
    }

    const distinct = new Set(this.stormLog.map((e) => e.identity));
    distinct.add(event.identity);

    if (distinct.size <= this.opts.stormBudget) {
      this.stormLog.push({ identity: event.identity, at: now });
      return null;
    }

    // Budget exceeded: emit a summary that preserves the distinct identities.
    this.stormLog.push({ identity: event.identity, at: now });
    return {
      identity: `storm-summary::${now}`,
      ruleId: event.ruleId,
      source: event.source,
      severity: event.severity,
      value: event.value,
      threshold: event.threshold,
      firedAt: now,
      summary: true,
      coalesced: Array.from(distinct),
    };
  }

  private broadcast(event: AlertEvent): void {
    if (!this.opts.channel) return;
    this.opts.channel.postMessage({
      type: 'alert-fired',
      originId: this.opts.originId,
      identity: event.identity,
      firedAt: event.firedAt,
    });
  }

  private onBroadcast = (msg: MessageEvent): void => {
    const data = msg.data;
    if (!data || data.type !== 'alert-fired') return;
    if (data.originId && data.originId === this.opts.originId) return;
    this.seenRemote.add(data.identity);
  };
}
