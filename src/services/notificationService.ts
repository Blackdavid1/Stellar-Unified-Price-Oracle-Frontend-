import { EventEmitter } from 'events';
import { notificationConfig, NotificationRule, NotificationChannel } from '../config/notificationConfig';

export interface Alert {
  id: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SnoozeConfig {
  durationMs: number;
  until?: number;
}

export interface QuietHoursConfig {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  timezone: string;
}

export interface HeldAlert {
  alert: Alert;
  channel: NotificationChannel;
  heldAt: number;
  releaseAt: number;
}

export interface SuppressionState {
  ruleId: string;
  channel: NotificationChannel;
  reason: 'snooze' | 'quiet_hours';
  until: number;
}

interface RuleSuppression {
  snoozeUntil?: number;
  quietHours?: QuietHoursConfig;
}

const MINUTES_PER_DAY = 24 * 60;

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(':').map((v) => parseInt(v, 10));
  return (h % 24) * 60 + (m % 60);
}

function getZonedMinutes(timestamp: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return (hour % 24) * 60 + minute;
}

function isWithinQuietHours(timestamp: number, config: QuietHoursConfig): boolean {
  const now = getZonedMinutes(timestamp, config.timezone);
  const start = parseTimeToMinutes(config.start);
  const end = parseTimeToMinutes(config.end);
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  // Window wraps past midnight.
  return now >= start || now < end;
}

function nextQuietHoursEnd(timestamp: number, config: QuietHoursConfig): number {
  const end = parseTimeToMinutes(config.end);
  const now = getZonedMinutes(timestamp, config.timezone);
  let deltaMinutes = end - now;
  if (deltaMinutes <= 0) deltaMinutes += MINUTES_PER_DAY;
  return timestamp + deltaMinutes * 60 * 1000;
}

export class NotificationService extends EventEmitter {
  private suppressions = new Map<string, RuleSuppression>();
  private heldAlerts: HeldAlert[] = [];
  private releaseTimer?: NodeJS.Timeout;

  constructor(private config = notificationConfig) {
    super();
  }

  /** Configure snooze for a rule. */
  snoozeRule(ruleId: string, durationMs: number, now = Date.now()): void {
    const existing = this.suppressions.get(ruleId) ?? {};
    existing.snoozeUntil = now + durationMs;
    this.suppressions.set(ruleId, existing);
    this.emit('suppression:changed', this.getSuppressionState());
    this.scheduleRelease();
  }

  /** Clear an active snooze for a rule. */
  clearSnooze(ruleId: string): void {
    const existing = this.suppressions.get(ruleId);
    if (!existing) return;
    delete existing.snoozeUntil;
    this.suppressions.set(ruleId, existing);
    this.emit('suppression:changed', this.getSuppressionState());
  }

  /** Configure quiet hours for a channel. */
  setQuietHours(channel: NotificationChannel, config: QuietHoursConfig): void {
    const key = this.channelKey(channel);
    const existing = this.suppressions.get(key) ?? {};
    existing.quietHours = config;
    this.suppressions.set(key, existing);
    this.emit('suppression:changed', this.getSuppressionState());
    this.scheduleRelease();
  }

  clearQuietHours(channel: NotificationChannel): void {
    const key = this.channelKey(channel);
    const existing = this.suppressions.get(key);
    if (!existing) return;
    delete existing.quietHours;
    this.suppressions.set(key, existing);
    this.emit('suppression:changed', this.getSuppressionState());
  }

  /**
   * Evaluate an alert and deliver it, or hold delivery when suppressed.
   * The alert is always recorded regardless of suppression.
   */
  async notify(alert: Alert, now = Date.now()): Promise<void> {
    this.emit('alert:recorded', alert);

    const rule = this.config.rules.find((r) => r.id === alert.ruleId);
    if (!rule) return;

    for (const channel of rule.channels) {
      const suppression = this.getActiveSuppression(alert.ruleId, channel, now);
      if (suppression) {
        this.heldAlerts.push({
          alert,
          channel,
          heldAt: now,
          releaseAt: suppression.until,
        });
        this.emit('alert:held', { alert, channel, reason: suppression.reason, until: suppression.until });
      } else {
        await this.deliver(alert, channel);
      }
    }

    this.scheduleRelease();
  }

  /** Release all held alerts whose suppression window has ended. */
  async releaseHeldAlerts(now = Date.now()): Promise<void> {
    const due = this.heldAlerts.filter((h) => h.releaseAt <= now);
    if (due.length === 0) return;
    this.heldAlerts = this.heldAlerts.filter((h) => h.releaseAt > now);

    const digest = new Map<NotificationChannel, Alert[]>();
    for (const held of due) {
      const list = digest.get(held.channel) ?? [];
      list.push(held.alert);
      digest.set(held.channel, list);
    }

    for (const [channel, alerts] of digest) {
      this.emit('digest:released', { channel, alerts });
      for (const alert of alerts) {
        await this.deliver(alert, channel);
      }
    }

    this.scheduleRelease();
  }

  /** Current suppression state for UI display. */
  getSuppressionState(now = Date.now()): SuppressionState[] {
    const states: SuppressionState[] = [];
    for (const [key, value] of this.suppressions) {
      if (value.snoozeUntil && value.snoozeUntil > now) {
        states.push({ ruleId: key, channel: 'all' as NotificationChannel, reason: 'snooze', until: value.snoozeUntil });
      }
      if (value.quietHours && isWithinQuietHours(now, value.quietHours)) {
        states.push({
          ruleId: key,
          channel: key as NotificationChannel,
          reason: 'quiet_hours',
          until: nextQuietHoursEnd(now, value.quietHours),
        });
      }
    }
    return states;
  }

  getHeldAlerts(): HeldAlert[] {
    return [...this.heldAlerts];
  }

  private getActiveSuppression(
    ruleId: string,
    channel: NotificationChannel,
    now: number,
  ): { reason: 'snooze' | 'quiet_hours'; until: number } | undefined {
    const ruleSuppression = this.suppressions.get(ruleId);
    if (ruleSuppression?.snoozeUntil && ruleSuppression.snoozeUntil > now) {
      return { reason: 'snooze', until: ruleSuppression.snoozeUntil };
    }

    const channelSuppression = this.suppressions.get(this.channelKey(channel));
    if (channelSuppression?.quietHours && isWithinQuietHours(now, channelSuppression.quietHours)) {
      return {
        reason: 'quiet_hours',
        until: nextQuietHoursEnd(now, channelSuppression.quietHours),
      };
    }

    return undefined;
  }

  private channelKey(channel: NotificationChannel): string {
    return `channel:${channel}`;
  }

  private scheduleRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.heldAlerts.length === 0) return;
    const next = Math.min(...this.heldAlerts.map((h) => h.releaseAt));
    const delay = Math.max(0, next - Date.now());
    this.releaseTimer = setTimeout(() => {
      void this.releaseHeldAlerts();
    }, delay);
    if (typeof this.releaseTimer.unref === 'function') this.releaseTimer.unref();
  }

  private async deliver(alert: Alert, channel: NotificationChannel): Promise<void> {
    this.emit('alert:delivered', { alert, channel });
  }
}

export const notificationService = new NotificationService();
