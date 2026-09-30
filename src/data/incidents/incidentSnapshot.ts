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
  /** ISO-8601 timestamp of the tick. */
  timestamp: string;
  /** Source that produced the tick (e.g. "binance", "coinbase"). */
  source: string;
  /** Observed value for the tick. */
  value: number;
}

export interface AggregateState {
  /** Number of ticks folded into the aggregate. */
  count: number;
  /** Arithmetic mean of the folded tick values. */
  mean: number;
  /** Minimum folded tick value. */
  min: number;
  /** Maximum folded tick value. */
  max: number;
}

export interface StrategyConfig {
  /** Strategy identifier. */
  id: string;
  /** Strategy parameters, kept as a plain record for replay. */
  params: Record<string, number | string | boolean>;
}

export interface IncidentTrigger {
  /** Machine-readable incident kind, e.g. "source_spike". */
  kind: string;
  /** Human-readable description of what tripped the trigger. */
  reason: string;
  /** ISO-8601 timestamp of the trigger. */
  at: string;
  /** Source(s) implicated by the trigger. */
  sources: string[];
}

export interface IncidentSnapshot {
  /** Stable snapshot id, derived deterministically from the trigger. */
  id: string;
  /** Schema version so the harness can evolve the replay format. */
  version: 1;
  /** The trigger that caused this snapshot to be captured. */
  trigger: IncidentTrigger;
  /** Bounded window of recent ticks, ordered by seq ascending. */
  ticks: Tick[];
  /** Aggregate state at capture time. */
  aggregate: AggregateState;
  /** Strategy config in effect at capture time. */
  strategy: StrategyConfig;
  /** Exclusions applied at capture time. */
  exclusions: string[];
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
  /** ISO-8601 expiry timestamp, after which the snapshot is dropped. */
  expiresAt: string;
}

export interface IncidentTimelineEntry {
  /** ISO-8601 timestamp of the entry. */
  at: string;
  /** Short label for the entry. */
  label: string;
  /** Source that contributed to the entry, if any. */
  source?: string;
}

export interface IncidentView {
  /** Snapshot id this view renders. */
  id: string;
  /** Ordered timeline of the incident. */
  timeline: IncidentTimelineEntry[];
  /** Sources that contributed to the incident. */
  contributingSources: string[];
  /** Whether the snapshot is still within its retention window. */
  replayable: boolean;
}

/**
 * Documented retention window for incident snapshots. Snapshots older than
 * this are considered expired and are dropped on read/write.
 */
export const INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Maximum number of ticks retained in a bounded snapshot. */
export const INCIDENT_TICK_LIMIT = 500;

export interface CaptureOptions {
  /** Recent ticks, in any order; the capture bounds and orders them. */
  ticks: Tick[];
  /** Aggregate state at capture time. */
  aggregate: AggregateState;
  /** Strategy config at capture time. */
  strategy: StrategyConfig;
  /** Exclusions applied at capture time. */
  exclusions: string[];
  /** The trigger that caused the capture. */
  trigger: IncidentTrigger;
  /** Capture timestamp; defaults to the trigger timestamp. */
  capturedAt?: string;
  /** Retention window override; defaults to INCIDENT_RETENTION_MS. */
  retentionMs?: number;
  /** Tick bound override; defaults to INCIDENT_TICK_LIMIT. */
  tickLimit?: number;
}

function stableId(trigger: IncidentTrigger): string {
  const sources = [...trigger.sources].sort().join(",");
  return `incident:${trigger.kind}:${trigger.at}:${sources}`;
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * Capture a bounded, replayable snapshot from a quality incident trigger.
 *
 * The snapshot is deterministic: ticks are ordered by seq ascending and
 * truncated to the most recent `tickLimit` entries, so replaying the same
 * inputs always yields the same snapshot.
 */
export function captureIncidentSnapshot(options: CaptureOptions): IncidentSnapshot {
  const {
    ticks,
    aggregate,
    strategy,
    exclusions,
    trigger,
    capturedAt = trigger.at,
    retentionMs = INCIDENT_RETENTION_MS,
    tickLimit = INCIDENT_TICK_LIMIT,
  } = options;

  const bounded = [...ticks]
    .sort((a, b) => a.seq - b.seq)
    .slice(-tickLimit);

  return {
    id: stableId(trigger),
    version: 1,
    trigger,
    ticks: bounded,
    aggregate,
    strategy,
    exclusions: [...exclusions],
    capturedAt,
    expiresAt: addMs(capturedAt, retentionMs),
  };
}

/**
 * Replay a snapshot deterministically. Returns the bounded ticks and the
 * aggregate recomputed from them, so the harness (#609) can assert that the
 * captured aggregate matches the replayed one.
 */
export function replayIncidentSnapshot(snapshot: IncidentSnapshot): {
  ticks: Tick[];
  aggregate: AggregateState;
} {
  const ticks = [...snapshot.ticks].sort((a, b) => a.seq - b.seq);
  const values = ticks.map((t) => t.value);
  const aggregate: AggregateState = {
    count: values.length,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
  return { ticks, aggregate };
}

/** Whether a snapshot is still within its retention window at `now`. */
export function isSnapshotReplayable(
  snapshot: IncidentSnapshot,
  now: string = new Date().toISOString(),
): boolean {
  return new Date(snapshot.expiresAt).getTime() > new Date(now).getTime();
}

/**
 * Render an incident view: the timeline of the incident plus the contributing
 * sources. Expired snapshots are marked non-replayable.
 */
export function renderIncidentView(
  snapshot: IncidentSnapshot,
  now: string = new Date().toISOString(),
): IncidentView {
  const timeline: IncidentTimelineEntry[] = [
    {
      at: snapshot.trigger.at,
      label: `trigger: ${snapshot.trigger.kind} (${snapshot.trigger.reason})`,
    },
    ...snapshot.ticks.map((tick) => ({
      at: tick.timestamp,
      label: `tick #${tick.seq} = ${tick.value}`,
      source: tick.source,
    })),
    {
      at: snapshot.capturedAt,
      label: "snapshot captured",
    },
  ];

  const contributingSources = Array.from(
    new Set([
      ...snapshot.trigger.sources,
      ...snapshot.ticks.map((t) => t.source),
    ]),
  ).sort();

  return {
    id: snapshot.id,
    timeline,
    contributingSources,
    replayable: isSnapshotReplayable(snapshot, now),
  };
}

/**
 * In-memory store for incident snapshots with retention/expiry enforcement.
 * Expired snapshots are dropped on read and write.
 */
export class IncidentSnapshotStore {
  private readonly snapshots = new Map<string, IncidentSnapshot>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /** Store a snapshot, dropping it immediately if it is already expired. */
  put(snapshot: IncidentSnapshot): void {
    if (!isSnapshotReplayable(snapshot, this.now())) {
      this.snapshots.delete(snapshot.id);
      return;
    }
    this.snapshots.set(snapshot.id, snapshot);
  }

  /** Retrieve a snapshot, enforcing retention on read. */
  get(id: string): IncidentSnapshot | undefined {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return undefined;
    if (!isSnapshotReplayable(snapshot, this.now())) {
      this.snapshots.delete(id);
      return undefined;
    }
    return snapshot;
  }

  /** Drop all expired snapshots; returns the number removed. */
  expire(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, snapshot] of this.snapshots) {
      if (!isSnapshotReplayable(snapshot, now)) {
        this.snapshots.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of live (non-expired) snapshots. */
  size(): number {
    this.expire();
    return this.snapshots.size;
  }
}
