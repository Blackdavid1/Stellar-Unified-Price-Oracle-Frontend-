/**
 * Adaptive reconnection backoff tuned to observed network quality.
 *
 * Builds on the fixed-parameter backoff from #602 by measuring network
 * quality (success ratio, RTT, error mix) and adapting jitter/caps to it.
 * Adds a fast-recovery probe path for online events and a churn cap that
 * escalates to the transport manager when WS cannot stabilize.
 *
 * The no-duplicate-alerts guarantee (#602) is preserved: this module only
 * decides *when* to reconnect and never emits alerts itself.
 */

/** Observed network quality used to tune backoff parameters. */
export interface NetworkQuality {
  /** Ratio of successful attempts to total attempts, in [0, 1]. */
  successRatio: number;
  /** Smoothed round-trip time in milliseconds. */
  rttMs: number;
  /** Fraction of failures caused by transport/network errors, in [0, 1]. */
  networkErrorRatio: number;
}

/** Backoff parameters derived from observed network quality. */
export interface BackoffParams {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/** Callbacks the reconnect controller uses to drive the transport. */
export interface ReconnectTransport {
  /** Attempt a single reconnect. Resolves true on success. */
  connect: () => Promise<boolean>;
  /** Called when churn cap is exceeded and WS cannot stabilize. */
  escalate: (reason: string) => void;
}

export interface ReconnectOptions {
  transport: ReconnectTransport;
  /** Injectable clock/scheduler for testability. */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Max reconnect attempts before escalating to the transport manager. */
  churnCap?: number;
  /** Window (ms) over which churn is measured. */
  churnWindowMs?: number;
}

const DEFAULT_QUALITY: NetworkQuality = {
  successRatio: 1,
  rttMs: 100,
  networkErrorRatio: 0,
};

const DEFAULT_CHURN_CAP = 8;
const DEFAULT_CHURN_WINDOW_MS = 60_000;

/**
 * Derive backoff parameters from observed network quality.
 *
 * Poor quality (low success ratio, high RTT, network-heavy errors) yields a
 * shorter base delay and more jitter so a flaky mobile link recovers faster.
 * Good quality yields a longer base delay and less jitter so a transient blip
 * on a stable link does not trigger an unnecessarily long wait.
 */
export function computeBackoffParams(quality: NetworkQuality): BackoffParams {
  const successRatio = clamp01(quality.successRatio);
  const networkErrorRatio = clamp01(quality.networkErrorRatio);
  const rttMs = Math.max(0, quality.rttMs);

  // 0 = healthy, 1 = degraded.
  const rttPenalty = clamp01(rttMs / 1000);
  const degradation = clamp01(
    (1 - successRatio) * 0.5 + networkErrorRatio * 0.3 + rttPenalty * 0.2,
  );

  // Degraded links: shorter base (fast recovery), higher jitter (spread load).
  const baseDelayMs = Math.round(lerp(2000, 250, degradation));
  const maxDelayMs = Math.round(lerp(30_000, 5000, degradation));
  const jitterRatio = round2(lerp(0.1, 0.5, degradation));

  return { baseDelayMs, maxDelayMs, jitterRatio };
}

/**
 * Compute the delay for a given attempt using adaptive params.
 * Exponential growth is capped at maxDelayMs and jittered by jitterRatio.
 */
export function computeDelay(
  attempt: number,
  params: BackoffParams,
  random: () => number = Math.random,
): number {
  const exp = Math.min(attempt, 10);
  const raw = Math.min(params.baseDelayMs * 2 ** exp, params.maxDelayMs);
  const jitter = raw * params.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/**
 * Adaptive reconnect controller.
 *
 * Tracks observed quality, schedules reconnects with adaptive backoff,
 * supports a fast-recovery probe on online events, and escalates to the
 * transport manager once the churn cap is exceeded.
 */
export class AdaptiveReconnectController {
  private readonly transport: ReconnectTransport;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly churnCap: number;
  private readonly churnWindowMs: number;

  private quality: NetworkQuality = { ...DEFAULT_QUALITY };
  private attempt = 0;
  private timer: unknown = null;
  private online = true;
  private stopped = false;
  private churnTimestamps: number[] = [];
  private escalated = false;

  constructor(options: ReconnectOptions) {
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    this.churnCap = options.churnCap ?? DEFAULT_CHURN_CAP;
    this.churnWindowMs = options.churnWindowMs ?? DEFAULT_CHURN_WINDOW_MS;
  }

  /** Record the outcome of a connection attempt to update quality metrics. */
  recordAttempt(success: boolean, rttMs: number, networkError: boolean): void {
    const prev = this.quality;
    const alpha = 0.3; // exponential moving average
    this.quality = {
      successRatio: ema(prev.successRatio, success ? 1 : 0, alpha),
      rttMs: ema(prev.rttMs, rttMs, alpha),
      networkErrorRatio: ema(
        prev.networkErrorRatio,
        networkError ? 1 : 0,
        alpha,
      ),
    };
  }

  /** Current adaptive backoff parameters. */
  getBackoffParams(): BackoffParams {
    return computeBackoffParams(this.quality);
  }

  /**
   * Signal that the network came back online. Triggers a fast-recovery probe
   * instead of waiting out the current backoff.
   */
  onOnline(): void {
    this.online = true;
    if (this.stopped) return;
    this.clearTimer();
    // Fast-recovery probe: reconnect almost immediately.
    this.scheduleProbe(0);
  }

  /** Signal that the network went offline; pause reconnect attempts. */
  onOffline(): void {
    this.online = false;
    this.clearTimer();
  }

  /** Begin the reconnect loop after a disconnect. */
  start(): void {
    this.stopped = false;
    this.escalated = false;
    this.attempt = 0;
    this.scheduleNext();
  }

  /** Stop the reconnect loop and clear any pending timer. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private scheduleNext(): void {
    if (this.stopped || !this.online) return;
    const params = this.getBackoffParams();
    const delay = computeDelay(this.attempt, params);
    this.scheduleProbe(delay);
  }

  private scheduleProbe(delayMs: number): void {
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.runAttempt();
    }, delayMs);
  }

  private async runAttempt(): Promise<void> {
    if (this.stopped || !this.online) return;

    if (this.exceedsChurnCap()) {
      this.escalate('reconnect churn cap exceeded');
      return;
    }
    this.churnTimestamps.push(this.now());

    const startedAt = this.now();
    let success = false;
    let networkError = false;
    try {
      success = await this.transport.connect();
    } catch {
      networkError = true;
    }
    const rttMs = this.now() - startedAt;
    this.recordAttempt(success, rttMs, networkError);

    if (success) {
      this.attempt = 0;
      return;
    }

    this.attempt += 1;
    this.scheduleNext();
  }

  private exceedsChurnCap(): boolean {
    const cutoff = this.now() - this.churnWindowMs;
    this.churnTimestamps = this.churnTimestamps.filter((t) => t >= cutoff);
    return this.churnTimestamps.length >= this.churnCap;
  }

  private escalate(reason: string): void {
    if (this.escalated) return;
    this.escalated = true;
    this.stopped = true;
    this.clearTimer();
    this.transport.escalate(reason);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ema(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha;
}
