/**
 * Staleness and gap accounting for price sources (#665).
 *
 * Quantifies expected-vs-received ticks per source over a window so callers can
 * tell whether an aggregate price is well-supported or starved. Accounting is
 * cadence-aware: sources that publish on irregular schedules are compared
 * against their own observed cadence rather than a fixed global rate.
 */

export interface TickSample {
  /** Source identifier (e.g. oracle name). */
  source: string;
  /** Timestamp of the received tick, in milliseconds. */
  timestamp: number;
}

export interface CoverageWindow {
  /** Inclusive start of the window, in milliseconds. */
  start: number;
  /** Exclusive end of the window, in milliseconds. */
  end: number;
}

export interface SourceCoverage {
  source: string;
  /** Ticks actually received within the window. */
  received: number;
  /** Ticks expected within the window given the source cadence. */
  expected: number;
  /** received / expected, clamped to [0, 1]. 1 when no ticks are expected. */
  coverage: number;
  /** expected - received, floored at 0. */
  gap: number;
  /** Median inter-tick interval observed for the source, in ms. */
  cadenceMs: number;
  /** True when the source produced no ticks in the window. */
  silent: boolean;
}

/**
 * Fallback cadence used when a source has too few samples to infer its own
 * publishing rhythm. Kept conservative so a sparse source is not penalised as
 * if it were expected to publish at a high fixed rate.
 */
const DEFAULT_CADENCE_MS = 60_000;

/** Minimum number of intervals required before trusting an inferred cadence. */
const MIN_INTERVALS_FOR_CADENCE = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Infer a source's publishing cadence from its tick timestamps. Uses the median
 * inter-tick interval so occasional bursts or gaps do not skew the estimate.
 * Falls back to DEFAULT_CADENCE_MS when there is not enough signal.
 */
export function inferCadenceMs(timestamps: number[]): number {
  if (timestamps.length < MIN_INTERVALS_FOR_CADENCE + 1) {
    return DEFAULT_CADENCE_MS;
  }
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i] - sorted[i - 1];
    if (delta > 0) intervals.push(delta);
  }
  const cadence = median(intervals);
  return cadence > 0 ? cadence : DEFAULT_CADENCE_MS;
}

/**
 * Compute expected-vs-received accounting for a single source over a window.
 *
 * Expected ticks are derived from the source's own cadence (cadence-aware), so
 * irregular feeds are judged fairly: a source that publishes every 5 minutes is
 * not marked starved for failing to publish every minute.
 */
export function computeSourceCoverage(
  source: string,
  timestamps: number[],
  window: CoverageWindow,
): SourceCoverage {
  const inWindow = timestamps.filter(
    (t) => t >= window.start && t < window.end,
  );
  const received = inWindow.length;

  const cadenceMs = inferCadenceMs(timestamps);
  const windowMs = Math.max(0, window.end - window.start);
  const expected =
    cadenceMs > 0 && windowMs > 0
      ? Math.max(1, Math.round(windowMs / cadenceMs))
      : 0;

  const gap = Math.max(0, expected - received);
  const coverage = expected === 0 ? 1 : Math.min(1, received / expected);

  return {
    source,
    received,
    expected,
    coverage,
    gap,
    cadenceMs,
    silent: received === 0,
  };
}

/**
 * Compute per-source coverage for every source present in the samples, plus any
 * sources explicitly listed even if they produced no ticks (so silent sources
 * are still accounted for).
 */
export function computeCoverageBySource(
  samples: TickSample[],
  window: CoverageWindow,
  knownSources: string[] = [],
): SourceCoverage[] {
  const bySource = new Map<string, number[]>();
  for (const source of knownSources) {
    if (!bySource.has(source)) bySource.set(source, []);
  }
  for (const sample of samples) {
    const list = bySource.get(sample.source);
    if (list) list.push(sample.timestamp);
    else bySource.set(sample.source, [sample.timestamp]);
  }

  return Array.from(bySource.entries()).map(([source, timestamps]) =>
    computeSourceCoverage(source, timestamps, window),
  );
}

/**
 * Aggregate coverage across sources, weighting each source equally. A starved
 * aggregate (one or more silent sources) yields a coverage well below 1 so
 * downstream confidence can be reduced accordingly.
 */
export function aggregateCoverage(coverages: SourceCoverage[]): number {
  if (coverages.length === 0) return 0;
  const total = coverages.reduce((sum, c) => sum + c.coverage, 0);
  return total / coverages.length;
}

/**
 * Map aggregate coverage onto a confidence multiplier in [0, 1]. Full coverage
 * leaves confidence untouched; starved aggregates scale it down proportionally.
 */
export function coverageConfidenceMultiplier(coverage: number): number {
  if (!Number.isFinite(coverage)) return 0;
  return Math.max(0, Math.min(1, coverage));
}
