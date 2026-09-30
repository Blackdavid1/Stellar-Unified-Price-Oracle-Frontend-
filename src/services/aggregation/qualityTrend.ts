/**
 * Quality trend accounting for aggregated price sources.
 *
 * Issue #665: quantify staleness and gaps per source so consumers can tell
 * whether an aggregate price is well-supported or starved. We account for
 * expected-vs-received ticks per source over each window, produce coverage and
 * gap stats, and expose a cadence-aware view that treats sources with
 * non-uniform publishing cadence fairly.
 */

export interface TickSample {
  /** Source identifier (e.g. oracle name). */
  source: string;
  /** Timestamp (ms) at which the tick was received. */
  timestamp: number;
}

export interface SourceCoverage {
  source: string;
  /** Ticks we expected to receive in the window given the source cadence. */
  expected: number;
  /** Ticks actually received in the window. */
  received: number;
  /** received / expected, clamped to [0, 1]. */
  coverage: number;
  /** expected - received, never negative. */
  gap: number;
  /** Observed median inter-tick interval (ms), or null when undetermined. */
  cadenceMs: number | null;
}

export interface CoverageWindow {
  windowStart: number;
  windowEnd: number;
  sources: SourceCoverage[];
  /** Aggregate coverage across all sources, weighted by expected ticks. */
  aggregateCoverage: number;
  /** Total missing ticks across all sources. */
  totalGap: number;
}

/**
 * Default cadence used when a source has too few samples to infer its own
 * publishing interval. Kept conservative so sparse feeds are not penalised
 * for being sparse by design.
 */
export const DEFAULT_CADENCE_MS = 60_000;

/** Minimum samples required before we trust an inferred cadence. */
const MIN_SAMPLES_FOR_CADENCE = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Infer a source's publishing cadence from its observed inter-tick intervals.
 * Uses the median so a single burst or outage does not skew the estimate.
 * Returns null when there are too few samples to be confident.
 */
export function inferCadenceMs(timestamps: number[]): number | null {
  if (timestamps.length < MIN_SAMPLES_FOR_CADENCE) return null;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i] - sorted[i - 1];
    if (delta > 0) intervals.push(delta);
  }
  return median(intervals);
}

/**
 * Compute expected-vs-received accounting for a single source over a window.
 *
 * Cadence-aware: when the source publishes irregularly we derive its expected
 * tick count from its own observed cadence rather than a fixed global rate, so
 * a slow-but-healthy feed is not reported as starved.
 */
export function computeSourceCoverage(
  source: string,
  timestamps: number[],
  windowStart: number,
  windowEnd: number,
  fallbackCadenceMs: number = DEFAULT_CADENCE_MS,
): SourceCoverage {
  const inWindow = timestamps.filter(
    (t) => t >= windowStart && t <= windowEnd,
  );
  const received = inWindow.length;

  const cadenceMs = inferCadenceMs(timestamps) ?? fallbackCadenceMs;
  const windowMs = Math.max(0, windowEnd - windowStart);
  const expected =
    cadenceMs > 0 ? Math.max(1, Math.round(windowMs / cadenceMs)) : received;

  const coverage = expected > 0 ? Math.min(1, received / expected) : 1;
  const gap = Math.max(0, expected - received);

  return { source, expected, received, coverage, gap, cadenceMs };
}

/**
 * Build a coverage window across all sources, producing per-source stats and
 * an aggregate coverage weighted by each source's expected tick count.
 */
export function computeCoverageWindow(
  samples: TickSample[],
  windowStart: number,
  windowEnd: number,
  fallbackCadenceMs: number = DEFAULT_CADENCE_MS,
): CoverageWindow {
  const bySource = new Map<string, number[]>();
  for (const sample of samples) {
    const list = bySource.get(sample.source);
    if (list) list.push(sample.timestamp);
    else bySource.set(sample.source, [sample.timestamp]);
  }

  const sources: SourceCoverage[] = [];
  for (const [source, timestamps] of bySource) {
    sources.push(
      computeSourceCoverage(
        source,
        timestamps,
        windowStart,
        windowEnd,
        fallbackCadenceMs,
      ),
    );
  }

  const totalExpected = sources.reduce((sum, s) => sum + s.expected, 0);
  const totalReceived = sources.reduce((sum, s) => sum + s.received, 0);
  const totalGap = sources.reduce((sum, s) => sum + s.gap, 0);
  const aggregateCoverage =
    totalExpected > 0 ? Math.min(1, totalReceived / totalExpected) : 1;

  return { windowStart, windowEnd, sources, aggregateCoverage, totalGap };
}

/**
 * Derive a confidence multiplier from coverage so a starved aggregate reports
 * lower confidence. Full coverage leaves confidence untouched; partial
 * coverage scales it down proportionally.
 */
export function coverageConfidenceFactor(coverage: number): number {
  if (!Number.isFinite(coverage)) return 1;
  return Math.max(0, Math.min(1, coverage));
}

/**
 * Apply coverage to a base confidence score, returning the adjusted value.
 */
export function applyCoverageToConfidence(
  baseConfidence: number,
  coverage: number,
): number {
  return Math.max(0, Math.min(1, baseConfidence * coverageConfidenceFactor(coverage)));
}
