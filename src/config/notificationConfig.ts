export type NotificationChannel = 'email' | 'sms' | 'push' | 'webhook';

export interface AlertRule {
  id: string;
  name: string;
  severity: 'info' | 'warning' | 'critical';
  channels: NotificationChannel[];
  /** Optional snooze configuration for this rule. */
  snooze?: SnoozeConfig;
}

export interface SnoozeConfig {
  /** Duration in minutes for which delivery is held once snoozed. */
  durationMinutes: number;
  /** Epoch millis at which the snooze was activated. */
  snoozedAt?: number;
}

export interface QuietHoursConfig {
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Start of the quiet window in "HH:mm" 24h local time. */
  start: string;
  /** End of the quiet window in "HH:mm" 24h local time. */
  end: string;
}

export interface ChannelConfig {
  channel: NotificationChannel;
  enabled: boolean;
  /** Optional quiet hours for this channel. */
  quietHours?: QuietHoursConfig;
}

export interface NotificationConfig {
  rules: AlertRule[];
  channels: ChannelConfig[];
}

export interface Alert {
  id: string;
  ruleId: string;
  severity: AlertRule['severity'];
  message: string;
  createdAt: number;
}

/**
 * An alert that was evaluated and recorded but whose delivery is held by
 * snooze or quiet hours. Held alerts are never dropped; they are released as
 * a digest once the suppression window ends.
 */
export interface HeldAlert {
  alert: Alert;
  channel: NotificationChannel;
  /** Epoch millis at which delivery may resume. */
  releaseAt: number;
  reason: 'snooze' | 'quiet_hours';
}

export interface SuppressionState {
  ruleId: string;
  channel: NotificationChannel;
  reason: 'snooze' | 'quiet_hours';
  /** Epoch millis at which suppression ends. */
  until: number;
}

const MINUTE_MS = 60 * 1000;

/** Parse "HH:mm" into minutes since local midnight. */
function parseTimeOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

/**
 * Compute the local minutes-since-midnight for a timestamp in a given IANA
 * timezone. Uses Intl so it works with the virtual clock in tests.
 */
function localMinutesOfDay(timestamp: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return (hour % 24) * 60 + minute;
}

/**
 * Determine whether a timestamp falls inside a quiet-hours window. Handles
 * windows that wrap past midnight (e.g. 22:00 -> 07:00).
 */
export function isWithinQuietHours(timestamp: number, quietHours: QuietHoursConfig): boolean {
  const start = parseTimeOfDay(quietHours.start);
  const end = parseTimeOfDay(quietHours.end);
  const now = localMinutesOfDay(timestamp, quietHours.timezone);
  if (start === end) {
    return false;
  }
  if (start < end) {
    return now >= start && now < end;
  }
  // Wraps midnight.
  return now >= start || now < end;
}

/**
 * Compute the epoch millis at which a quiet-hours window ends for the given
 * timestamp, so held alerts can be released as a digest.
 */
export function quietHoursReleaseAt(timestamp: number, quietHours: QuietHoursConfig): number {
  const end = parseTimeOfDay(quietHours.end);
  const now = localMinutesOfDay(timestamp, quietHours.timezone);
  let minutesUntilEnd = end - now;
  if (minutesUntilEnd <= 0) {
    minutesUntilEnd += 24 * 60;
  }
  return timestamp + minutesUntilEnd * MINUTE_MS;
}

/** Epoch millis at which a rule's snooze expires, or null if not snoozed. */
export function snoozeReleaseAt(rule: AlertRule): number | null {
  if (!rule.snooze || rule.snooze.snoozedAt === undefined) {
    return null;
  }
  return rule.snooze.snoozedAt + rule.snooze.durationMinutes * MINUTE_MS;
}

/**
 * Evaluate the suppression state for a rule/channel pair at a given time.
 * Returns null when delivery should proceed immediately.
 */
export function getSuppressionState(
  config: NotificationConfig,
  ruleId: string,
  channel: NotificationChannel,
  now: number,
): SuppressionState | null {
  const rule = config.rules.find((r) => r.id === ruleId);
  if (!rule) {
    return null;
  }

  const snoozeUntil = snoozeReleaseAt(rule);
  if (snoozeUntil !== null && now < snoozeUntil) {
    return { ruleId, channel, reason: 'snooze', until: snoozeUntil };
  }

  const channelConfig = config.channels.find((c) => c.channel === channel);
  if (channelConfig?.quietHours && isWithinQuietHours(now, channelConfig.quietHours)) {
    return {
      ruleId,
      channel,
      reason: 'quiet_hours',
      until: quietHoursReleaseAt(now, channelConfig.quietHours),
    };
  }

  return null;
}

/**
 * Route an alert to its channels. Alerts are always evaluated and recorded;
 * when a channel is suppressed the alert is held (not dropped) and returned
 * for later digest release.
 */
export function routeAlert(
  config: NotificationConfig,
  alert: Alert,
  now: number,
): { delivered: NotificationChannel[]; held: HeldAlert[] } {
  const rule = config.rules.find((r) => r.id === alert.ruleId);
  const delivered: NotificationChannel[] = [];
  const held: HeldAlert[] = [];

  if (!rule) {
    return { delivered, held };
  }

  for (const channel of rule.channels) {
    const channelConfig = config.channels.find((c) => c.channel === channel);
    if (channelConfig && !channelConfig.enabled) {
      continue;
    }

    const suppression = getSuppressionState(config, alert.ruleId, channel, now);
    if (suppression) {
      held.push({ alert, channel, releaseAt: suppression.until, reason: suppression.reason });
    } else {
      delivered.push(channel);
    }
  }

  return { delivered, held };
}

/**
 * Release held alerts whose suppression window has ended, grouped into a
 * digest per channel so nothing is lost.
 */
export function releaseDigest(
  held: HeldAlert[],
  now: number,
): { released: HeldAlert[]; stillHeld: HeldAlert[] } {
  const released: HeldAlert[] = [];
  const stillHeld: HeldAlert[] = [];
  for (const item of held) {
    if (now >= item.releaseAt) {
      released.push(item);
    } else {
      stillHeld.push(item);
    }
  }
  return { released, stillHeld };
}

/**
 * Summarize active suppression state for display on alerts and in the
 * notification settings UI.
 */
export function getActiveSuppressions(
  config: NotificationConfig,
  now: number,
): SuppressionState[] {
  const states: SuppressionState[] = [];
  for (const rule of config.rules) {
    for (const channel of rule.channels) {
      const state = getSuppressionState(config, rule.id, channel, now);
      if (state) {
        states.push(state);
      }
    }
  }
  return states;
}
