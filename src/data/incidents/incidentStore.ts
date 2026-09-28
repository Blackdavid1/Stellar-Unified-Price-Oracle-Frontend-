/**
 * Data-quality incident postmortems: automated replayable incident snapshots.
 *
 * On a quality incident trigger we capture a bounded, deterministic snapshot of
 * the recent ticks, aggregate state, strategy config and exclusions. Snapshots
 * are stored in a replayable format that the test harness (#609) can drive, and
 * they auto-expire according to a documented retention window.
 */

export interface Tick {
  /** Monotonic sequence number, used to order and bound the snapshot. */
  seq: number;
  /** Source that produced the tick (e.g. "binance", "coinbase"). */
  source: string;
  /** Observed value for the tick. */
  value: number;
  /** Epoch millis at which the tick was observed. */
  timestamp: number;
}

export interface AggregateState {
  /** Number of ticks folded into the aggregate. */
  count: number;
  /** Sum of tick values. */
  sum: number;
  /** Minimum observed value. */
  min: number;
  /** Maximum observed value. */
  max: number;
  /** Mean of observed values. */
  mean: number;
}

export interface StrategyConfig {
  /** Strategy identifier. */
  id: string;
  /** Strategy parameters, kept as a plain record for replay. */
  params: Record<string, number | string | boolean>;
}

export interface IncidentTrigger {
  /** Machine-readable incident kind, e.g. "source-misbehaviour". */
  kind: string;
  /** Human-readable description of what triggered the incident. */
  reason: string;
  /** Epoch millis at which the incident was detected. */
  detectedAt: number;
}

/**
 * A bounded, replayable snapshot of the data pipeline at incident time.
 * The shape is intentionally serialisable so the harness (#609) can drive it
 * back through the pipeline deterministically.
 */
export interface IncidentSnapshot {
  /** Stable snapshot id. */
  id: string;
  /** The trigger that caused this snapshot to be captured. */
  trigger: IncidentTrigger;
  /** Bounded window of recent ticks, ordered by seq ascending. */
  ticks: Tick[];
  /** Aggregate state at capture time. */
  aggregate: AggregateState;
  /** Strategy config in effect at capture time. */
  strategy: StrategyConfig;
  /** Sources excluded from aggregation at capture time. */
  exclusions: string[];
  /** Epoch millis at which the snapshot was captured. */
  capturedAt: number;
  /** Epoch millis after which the snapshot is expired and may be pruned. */
  expiresAt: number;
}

/**
 * Replayable, deterministic representation of a snapshot. The harness (#609)
 * consumes this directly: ticks are ordered by seq, and the aggregate is
 * recomputed from the ticks so replay is independent of capture-time state.
 */
export interface ReplayableSnapshot {
  id: string;
  trigger: IncidentTrigger;
  ticks: Tick[];
  strategy: StrategyConfig;
  exclusions: string[];
  capturedAt: number;
  expiresAt: number;
}

/**
 * A single entry in the incident timeline, annotated with the sources that
 * contributed to the state at that point.
 */
export interface IncidentTimelineEntry {
  seq: number;
  timestamp: number;
  value: number;
  /** Sources contributing to the aggregate at this point. */
  contributingSources: string[];
}

/**
 * Rendered incident view: the timeline plus the sources that contributed to
 * the incident, suitable for a postmortem UI.
 */
export interface IncidentView {
  id: string;
  trigger: IncidentTrigger;
  timeline: IncidentTimelineEntry[];
  contributingSources: string[];
  exclusions: string[];
  capturedAt: number;
  expiresAt: number;
}

export interface IncidentStoreOptions {
  /** Maximum number of ticks retained in a snapshot (bounded capture). */
  maxTicks?: number;
  /** Retention window in millis; snapshots expire after this duration. */
  retentionMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Documented defaults for bounded capture and retention. */
export const DEFAULT_MAX_TICKS = 500;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Computes the aggregate state from a set of ticks. Deterministic: the result
 * depends only on the tick values, not on insertion order.
 */
export function computeAggregate(ticks: Tick[]): AggregateState {
  if (ticks.length === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, mean: 0 };
  }
  let sum = 0;
  let min = ticks[0].value;
  let max = ticks[0].value;
  for (const tick of ticks) {
    sum += tick.value;
    if (tick.value < min) min = tick.value;
    if (tick.value > max) max = tick.value;
  }
  return {
    count: ticks.length,
    sum,
    min,
    max,
    mean: sum / ticks.length,
  };
}

/**
 * Captures a bounded, replayable snapshot on a quality incident trigger.
 *
 * The tick window is bounded to `maxTicks` most recent ticks (ordered by seq)
 * and the aggregate is recomputed from that bounded window so the snapshot is
 * self-consistent and replayable.
 */
export function captureSnapshot(
  trigger: IncidentTrigger,
  ticks: Tick[],
  strategy: StrategyConfig,
  exclusions: string[],
  options: IncidentStoreOptions = {},
): IncidentSnapshot {
  const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = options.now ?? Date.now;

  const bounded = [...ticks].sort((a, b) => a.seq - b.seq).slice(-maxTicks);
  const capturedAt = now();

  return {
    id: `incident-${trigger.detectedAt}-${bounded.length}`,
    trigger,
    ticks: bounded,
    aggregate: computeAggregate(bounded),
    strategy,
    exclusions: [...exclusions],
    capturedAt,
    expiresAt: capturedAt + retentionMs,
  };
}

/**
 * Converts a snapshot into the replayable format consumed by the harness
 * (#609). Ticks are ordered by seq so replay is deterministic.
 */
export function toReplayable(snapshot: IncidentSnapshot): ReplayableSnapshot {
  return {
    id: snapshot.id,
    trigger: snapshot.trigger,
    ticks: [...snapshot.ticks].sort((a, b) => a.seq - b.seq),
    strategy: snapshot.strategy,
    exclusions: [...snapshot.exclusions],
    capturedAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
  };
}

/**
 * Replays a snapshot deterministically, recomputing the aggregate from the
 * ordered ticks. Given the same snapshot, this always yields the same result.
 */
export function replaySnapshot(snapshot: ReplayableSnapshot): {
  ticks: Tick[];
  aggregate: AggregateState;
} {
  const ticks = [...snapshot.ticks].sort((a, b) => a.seq - b.seq);
  return { ticks, aggregate: computeAggregate(ticks) };
}

/**
 * Renders the incident view: a timeline of ticks annotated with the sources
 * contributing at each point, plus the overall contributing sources.
 */
export function renderIncidentView(snapshot: IncidentSnapshot): IncidentView {
  const excluded = new Set(snapshot.exclusions);
  const timeline: IncidentTimelineEntry[] = [];
  const contributing = new Set<string>();

  for (const tick of [...snapshot.ticks].sort((a, b) => a.seq - b.seq)) {
    if (excluded.has(tick.source)) continue;
    contributing.add(tick.source);
    timeline.push({
      seq: tick.seq,
      timestamp: tick.timestamp,
      value: tick.value,
      contributingSources: [...contributing].sort(),
    });
  }

  return {
    id: snapshot.id,
    trigger: snapshot.trigger,
    timeline,
    contributingSources: [...contributing].sort(),
    exclusions: [...snapshot.exclusions],
    capturedAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
  };
}

/**
 * In-memory store for incident snapshots with enforced retention/expiry.
 */
export class IncidentStore {
  private readonly snapshots = new Map<string, IncidentSnapshot>();
  private readonly options: IncidentStoreOptions;

  constructor(options: IncidentStoreOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Captures and stores a bounded, replayable snapshot. */
  capture(
    trigger: IncidentTrigger,
    ticks: Tick[],
    strategy: StrategyConfig,
    exclusions: string[],
  ): IncidentSnapshot {
    const snapshot = captureSnapshot(trigger, ticks, strategy, exclusions, this.options);
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  /** Returns a stored snapshot, or undefined if missing or expired. */
  get(id: string): IncidentSnapshot | undefined {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return undefined;
    if (this.isExpired(snapshot)) {
      this.snapshots.delete(id);
      return undefined;
    }
    return snapshot;
  }

  /** Returns the replayable form of a stored snapshot, if still retained. */
  getReplayable(id: string): ReplayableSnapshot | undefined {
    const snapshot = this.get(id);
    return snapshot ? toReplayable(snapshot) : undefined;
  }

  /** Returns the rendered incident view for a stored snapshot, if retained. */
  getView(id: string): IncidentView | undefined {
    const snapshot = this.get(id);
    return snapshot ? renderIncidentView(snapshot) : undefined;
  }

  /** Lists retained (non-expired) snapshots, pruning expired ones. */
  list(): IncidentSnapshot[] {
    this.prune();
    return [...this.snapshots.values()];
  }

  /** Removes expired snapshots, enforcing retention. */
  prune(): number {
    let removed = 0;
    for (const [id, snapshot] of this.snapshots) {
      if (this.isExpired(snapshot)) {
        this.snapshots.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private isExpired(snapshot: IncidentSnapshot): boolean {
    return this.now() >= snapshot.expiresAt;
  }
}
