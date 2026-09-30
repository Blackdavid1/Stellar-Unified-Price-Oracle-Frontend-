/**
 * Realtime connection quality SLOs.
 *
 * Tracks reconnect rate per session, p95 message lag, and drop rate from the
 * existing realtime monitor, surfaces breaches in diagnostics, raises a
 * meta-alert on sustained breach, and exports metrics to the analytics layer.
 */

export interface RealtimeSloThresholds {
  /** Max reconnects allowed per session before breach. */
  maxReconnectsPerSession: number;
  /** Max p95 message lag (ms) before breach. */
  maxP95LagMs: number;
  /** Max drop rate (0..1) before breach. */
  maxDropRate: number;
  /** Consecutive evaluation windows in breach before a meta-alert fires. */
  sustainedWindows: number;
}

export const DEFAULT_REALTIME_SLO_THRESHOLDS: RealtimeSloThresholds = {
  maxReconnectsPerSession: 3,
  maxP95LagMs: 2000,
  maxDropRate: 0.05,
  sustainedWindows: 3,
};

export interface RealtimeSloSnapshot {
  reconnectRate: number;
  p95LagMs: number;
  dropRate: number;
  breaches: RealtimeSloBreach[];
  breached: boolean;
  sustained: boolean;
  window: number;
}

export interface RealtimeSloBreach {
  metric: 'reconnectRate' | 'p95LagMs' | 'dropRate';
  value: number;
  threshold: number;
}

export interface RealtimeSloAlert {
  type: 'realtime-slo-breach';
  severity: 'warning' | 'critical';
  message: string;
  breaches: RealtimeSloBreach[];
  snapshot: RealtimeSloSnapshot;
  timestamp: number;
}

export interface RealtimeSloAnalyticsEvent {
  event: 'realtime_slo';
  reconnectRate: number;
  p95LagMs: number;
  dropRate: number;
  breached: boolean;
  sustained: boolean;
  breaches: RealtimeSloBreach[];
  timestamp: number;
}

export interface RealtimeSloMonitorOptions {
  thresholds?: Partial<RealtimeSloThresholds>;
  /** Sink for analytics export (RUM/quality analytics correlation). */
  onAnalytics?: (event: RealtimeSloAnalyticsEvent) => void;
  /** Maintainer meta-alert path. */
  onMetaAlert?: (alert: RealtimeSloAlert) => void;
  now?: () => number;
}

interface SessionState {
  reconnects: number;
  messages: number;
  drops: number;
  lagSamples: number[];
}

/**
 * Measures realtime connection quality SLOs from monitor signals and reports
 * breaches to diagnostics, analytics, and the maintainer alert path.
 */
export class RealtimeSloMonitor {
  private readonly thresholds: RealtimeSloThresholds;
  private readonly onAnalytics?: (event: RealtimeSloAnalyticsEvent) => void;
  private readonly onMetaAlert?: (alert: RealtimeSloAlert) => void;
  private readonly now: () => number;

  private sessions = new Map<string, SessionState>();
  private breachStreak = 0;
  private window = 0;
  private lastSnapshot: RealtimeSloSnapshot | null = null;

  constructor(options: RealtimeSloMonitorOptions = {}) {
    this.thresholds = { ...DEFAULT_REALTIME_SLO_THRESHOLDS, ...options.thresholds };
    this.onAnalytics = options.onAnalytics;
    this.onMetaAlert = options.onMetaAlert;
    this.now = options.now ?? (() => Date.now());
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { reconnects: 0, messages: 0, drops: 0, lagSamples: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Record a reconnect for a session. */
  recordReconnect(sessionId: string): void {
    this.session(sessionId).reconnects += 1;
  }

  /** Record a delivered message and its lag (ms). */
  recordMessage(sessionId: string, lagMs: number): void {
    const state = this.session(sessionId);
    state.messages += 1;
    if (Number.isFinite(lagMs) && lagMs >= 0) {
      state.lagSamples.push(lagMs);
    }
  }

  /** Record a dropped message for a session. */
  recordDrop(sessionId: string): void {
    this.session(sessionId).drops += 1;
  }

  /** Reset a session's counters (e.g. on clean close). */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private p95(samples: number[]): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[index];
  }

  /**
   * Evaluate the current SLO window across all sessions. Returns the snapshot,
   * surfaces breaches, exports analytics, and raises a meta-alert when the
   * breach is sustained across consecutive windows.
   */
  evaluate(): RealtimeSloSnapshot {
    let reconnects = 0;
    let messages = 0;
    let drops = 0;
    const lagSamples: number[] = [];

    for (const state of this.sessions.values()) {
      reconnects += state.reconnects;
      messages += state.messages;
      drops += state.drops;
      lagSamples.push(...state.lagSamples);
    }

    const sessionCount = this.sessions.size;
    const reconnectRate = sessionCount > 0 ? reconnects / sessionCount : 0;
    const p95LagMs = this.p95(lagSamples);
    const total = messages + drops;
    const dropRate = total > 0 ? drops / total : 0;

    const breaches: RealtimeSloBreach[] = [];
    if (reconnectRate > this.thresholds.maxReconnectsPerSession) {
      breaches.push({
        metric: 'reconnectRate',
        value: reconnectRate,
        threshold: this.thresholds.maxReconnectsPerSession,
      });
    }
    if (p95LagMs > this.thresholds.maxP95LagMs) {
      breaches.push({
        metric: 'p95LagMs',
        value: p95LagMs,
        threshold: this.thresholds.maxP95LagMs,
      });
    }
    if (dropRate > this.thresholds.maxDropRate) {
      breaches.push({
        metric: 'dropRate',
        value: dropRate,
        threshold: this.thresholds.maxDropRate,
      });
    }

    const breached = breaches.length > 0;
    this.breachStreak = breached ? this.breachStreak + 1 : 0;
    const sustained = this.breachStreak >= this.thresholds.sustainedWindows;
    this.window += 1;

    const snapshot: RealtimeSloSnapshot = {
      reconnectRate,
      p95LagMs,
      dropRate,
      breaches,
      breached,
      sustained,
      window: this.window,
    };
    this.lastSnapshot = snapshot;

    this.onAnalytics?.({
      event: 'realtime_slo',
      reconnectRate,
      p95LagMs,
      dropRate,
      breached,
      sustained,
      breaches,
      timestamp: this.now(),
    });

    if (sustained) {
      this.onMetaAlert?.({
        type: 'realtime-slo-breach',
        severity: 'critical',
        message: `Realtime SLO breach sustained for ${this.breachStreak} windows: ${breaches
          .map((b) => `${b.metric}=${b.value.toFixed(3)}>${b.threshold}`)
          .join(', ')}`,
        breaches,
        snapshot,
        timestamp: this.now(),
      });
    }

    return snapshot;
  }

  /** Latest snapshot for the diagnostics panel. */
  getSnapshot(): RealtimeSloSnapshot | null {
    return this.lastSnapshot;
  }

  /** Diagnostics-friendly breach summary. */
  getDiagnostics(): { breached: boolean; sustained: boolean; breaches: RealtimeSloBreach[] } {
    const snapshot = this.lastSnapshot;
    return {
      breached: snapshot?.breached ?? false,
      sustained: snapshot?.sustained ?? false,
      breaches: snapshot?.breaches ?? [],
    };
  }
}
