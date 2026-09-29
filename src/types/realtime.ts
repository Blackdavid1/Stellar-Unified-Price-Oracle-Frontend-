export type StreamId = string;

export interface SequencedFrame<T = unknown> {
  /** Monotonic per-stream sequence number. */
  seq: number;
  /** Stream this frame belongs to. */
  stream: StreamId;
  /** Frame payload. */
  payload: T;
  /** Optional server timestamp for diagnostics. */
  ts?: number;
}

export type FrameDisposition =
  | "applied"
  | "duplicate"
  | "reordered"
  | "dropped"
  | "gap";

export interface GapEvent {
  stream: StreamId;
  /** Last sequence number successfully applied before the gap. */
  expected: number;
  /** Sequence number of the frame that revealed the gap. */
  received: number;
  /** Number of missing frames (received - expected - 1). */
  missing: number;
  /** Pairs affected by the gap, marked stale until repaired. */
  affectedPairs: string[];
  /** Whether a backfill/resync has been requested for this gap. */
  backfillRequested: boolean;
  /** Timestamp the gap was detected. */
  detectedAt: number;
  /** Timestamp the gap was repaired, if it has been. */
  repairedAt?: number;
}

export interface StreamState {
  stream: StreamId;
  /** Highest contiguous sequence number applied. */
  lastApplied: number;
  /** Frames buffered awaiting a gap repair, keyed by seq. */
  pending: Map<number, SequencedFrame>;
  /** Pairs currently marked stale due to an unresolved gap. */
  stalePairs: Set<string>;
  /** Unresolved gaps for this stream. */
  gaps: GapEvent[];
}

export interface BackfillRequest {
  stream: StreamId;
  /** First missing sequence number (inclusive). */
  from: number;
  /** Last missing sequence number (inclusive). */
  to: number;
  reason: "gap" | "resync";
}

export interface BackfillResponse<T = unknown> {
  stream: StreamId;
  frames: SequencedFrame<T>[];
}

export interface DiagnosticsEntry {
  stream: StreamId;
  disposition: FrameDisposition;
  seq: number;
  expected?: number;
  missing?: number;
  affectedPairs?: string[];
  at: number;
}

export interface RealtimeDiagnostics {
  entries: DiagnosticsEntry[];
  gaps: GapEvent[];
  stalePairs: string[];
}
