/**
 * Alert storm control: deduplication, hysteresis/cooldown, cross-tab
 * coordination, and burst coalescing for the alert evaluator.
 *
 * Design goals (issue #648):
 *  - A single threshold crossing yields exactly one alert (hysteresis).
 *  - The same alert fires once per origin across tabs (broadcast channel).
 *  - Bursts beyond a rate are coalesced into a summary, never dropped.
 *  - Distinct alerts are deduped on identity, not merely on count.
 */

export interface AlertIdentity {
  /** Stable identity of the alert (e.g. symbol + condition + threshold). */
  id: string;
  /** Origin/source of the alert (e.g. tab id, source name). */
  origin?: string;
}

export interface StormControlOptions {
  /** Minimum time (ms) between two fires of the same alert identity. */
  cooldownMs?: number;
  /** Hysteresis band around a threshold to absorb oscillation. */
  hysteresis?: number;
  /** Max alerts allowed within the rolling window before coalescing. */
  burstLimit?: number;
  /** Rolling window (ms) used for burst detection. */
  burstWindowMs?: number;
  /** Broadcast channel used to coordinate across tabs. */
  channel?: BroadcastChannel | null;
  /** Unique id for this tab/origin. */
  originId?: string;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface CoalescedSummary {
  type: 'summary';
  count: number;
  identities: string[];
  windowMs: number;
}

export interface AlertDelivery {
  type: 'alert';
  identity: AlertIdentity;
}

export type StormDecision = AlertDelivery | CoalescedSummary | null;

interface IdentityState {
  lastFiredAt: number;
  /** Last observed value, used for hysteresis. */
  lastValue?: number;
  /** Whether the value is currently above the threshold. */
  above?: boolean;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_HYSTERESIS = 0;
const DEFAULT_BURST_LIMIT = 5;
const DEFAULT_BURST_WINDOW_MS = 10_000;

/**
 * Evaluates a threshold crossing with hysteresis so oscillation around the
 * threshold produces a single alert per genuine crossing.
 *
 * Returns true only when the value crosses the threshold in a direction that
 * is not already reflected by the previous state, accounting for the
 * hysteresis band.
 */
export function crossesThreshold(
  value: number,
  threshold: number,
  previousAbove: boolean | undefined,
  hysteresis: number = DEFAULT_HYSTERESIS,
): boolean {
  const upper = threshold + hysteresis;
  const lower = threshold - hysteresis;

  if (previousAbove === undefined) {
    // First observation: fire only if clearly above the upper band.
    return value >= upper;
  }

  if (previousAbove) {
    // Stay "above" until we fall below the lower band.
    return value < lower;
  }

  // Stay "below" until we rise above the upper band.
  return value >= upper;
}

/**
 * Coordinates alert delivery across tabs and applies cooldown, burst
 * coalescing, and identity-based deduplication.
 */
export class AlertStormControl {
  private readonly cooldownMs: number;
  private readonly hysteresis: number;
  private readonly burstLimit: number;
  private readonly burstWindowMs: number;
  private readonly originId: string;
  private readonly now: () => number;
  private readonly channel: BroadcastChannel | null;

  private readonly states = new Map<string, IdentityState>();
  private readonly recentFires: number[] = [];
  private readonly recentIdentities: string[] = [];
  private readonly seenRemote = new Set<string>();

  constructor(options: StormControlOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.hysteresis = options.hysteresis ?? DEFAULT_HYSTERESIS;
    this.burstLimit = options.burstLimit ?? DEFAULT_BURST_LIMIT;
    this.burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
    this.originId = options.originId ?? 'default';
    this.now = options.now ?? (() => Date.now());
    this.channel = options.channel ?? null;

    if (this.channel) {
      this.channel.addEventListener('message', this.handleRemote);
    }
  }

  /**
   * Evaluate a candidate alert. Returns an alert delivery, a coalesced
   * summary, or null when the alert is suppressed (cooldown / duplicate).
   */
  evaluate(identity: AlertIdentity, value?: number, threshold?: number): StormDecision {
    const key = this.identityKey(identity);
    const state = this.states.get(key);
    const now = this.now();

    // Hysteresis: only fire on a genuine crossing.
    if (value !== undefined && threshold !== undefined) {
      const above = crossesThreshold(value, threshold, state?.above, this.hysteresis);
      if (state && above === state.above) {
        return null;
      }
      this.states.set(key, { ...(state ?? { lastFiredAt: 0 }), above, lastValue: value });
    }

    // Cooldown: suppress repeat fires of the same identity.
    if (state && now - state.lastFiredAt < this.cooldownMs) {
      return null;
    }

    // Cross-tab coordination: if another origin already delivered this
    // identity, do not deliver it again here.
    if (this.seenRemote.has(key)) {
      return null;
    }

    // Burst budget: coalesce beyond the rate into a summary.
    this.pruneRecent(now);
    if (this.recentFires.length >= this.burstLimit) {
      this.recentFires.push(now);
      this.recentIdentities.push(key);
      return {
        type: 'summary',
        count: this.recentIdentities.length,
        identities: [...new Set(this.recentIdentities)],
        windowMs: this.burstWindowMs,
      };
    }

    // Deliver and record.
    this.states.set(key, { ...(state ?? { above: undefined }), lastFiredAt: now, lastValue: value });
    this.recentFires.push(now);
    this.recentIdentities.push(key);
    this.broadcast(key);

    return { type: 'alert', identity };
  }

  /** Reset all state (useful for tests and teardown). */
  reset(): void {
    this.states.clear();
    this.recentFires.length = 0;
    this.recentIdentities.length = 0;
    this.seenRemote.clear();
  }

  /** Detach the broadcast channel listener. */
  dispose(): void {
    if (this.channel) {
      this.channel.removeEventListener('message', this.handleRemote);
    }
  }

  private identityKey(identity: AlertIdentity): string {
    return identity.id;
  }

  private pruneRecent(now: number): void {
    const cutoff = now - this.burstWindowMs;
    while (this.recentFires.length > 0 && this.recentFires[0] < cutoff) {
      this.recentFires.shift();
      this.recentIdentities.shift();
    }
  }

  private broadcast(key: string): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({ type: 'alert-fired', key, origin: this.originId });
    } catch {
      // Broadcast failures must never break alert delivery.
    }
  }

  private readonly handleRemote = (event: MessageEvent): void => {
    const data = event.data as { type?: string; key?: string; origin?: string } | undefined;
    if (!data || data.type !== 'alert-fired' || !data.key) return;
    if (data.origin === this.originId) return;
    this.seenRemote.add(data.key);
  };
}
