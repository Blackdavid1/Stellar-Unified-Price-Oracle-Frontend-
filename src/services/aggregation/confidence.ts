/**
 * Coverage-aware confidence scoring for aggregated price sources.
 *
 * Issue #665: staleness and gap accounting. A silent or starved source
 * (#603) should not silently drag an aggregate down without explanation.
 * We quantify expected-vs-received ticks per source per window, derive
 * coverage/gap stats, and fold coverage into the confidence score so a
 * starved aggregate reports lower confidence.
 *
 * Cadence-aware: sources publish at different rates. We estimate each
 * source's expected tick count from its own observed cadence (median
 * inter-arrival time) rather than assuming a uniform global rate, so an
 * irregular feed is not unfairly penalized.
 */

export interface TickSample {
  /** Source identifier (e.g. oracle name). */
  source: string;
  /** Timestamp in ms since epoch. */
  timestamp: number;
}

export interface SourceCoverage {
  source: string;
  /** Ticks we expected given the source's own cadence over the window. */
  expected: number;
  /** Ticks actually received in the window. */
  received: number;
  /** received / expected, clamped to [0, 1]. 1 = fully covered. */
  coverage: number;
  /** Missing ticks = max(0, expected - received). */
  gap: number;
  /** Estimated cadence (median inter-arrival ms) used for expectation. */
  cadenceMs: number;
}

export interface CoverageReport {
  windowMs: number;
  perSource: SourceCoverage[];
  /** Aggregate coverage across sources, weighted by expected ticks. */
  aggregateCoverage: number;
  /** Total missing ticks across all sources. */
  totalGap: number;
}

const DEFAULT_CADENCE_MS = 60_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Estimate a source's publishing cadence from its own tick timestamps.
 * Uses the median inter-arrival time so occasional gaps do not inflate
 * the estimate. Falls back to a default when there is too little data.
 */
export function estimateCadenceMs(timestamps: number[]): number {
  if (timestamps.length < 2) return DEFAULT_CADENCE_MS;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0) deltas.push(d);
  }
  const cadence = median(deltas);
  return cadence > 0 ? cadence : DEFAULT_CADENCE_MS;
}

/**
 * Compute expected-vs-received accounting per source over a window.
 * `now` is the window end; the window spans [now - windowMs, now].
 */
export function computeCoverage(
  samples: TickSample[],
  windowMs: number,
  now: number = Date.now(),
): CoverageReport {
  const windowStart = now - windowMs;
  const bySource = new Map<string, number[]>();

  for (const s of samples) {
    if (s.timestamp < windowStart || s.timestamp > now) continue;
    const arr = bySource.get(s.source);
    if (arr) arr.push(s.timestamp);
    else bySource.set(s.source, [s.timestamp]);
  }

  const perSource: SourceCoverage[] = [];
  let weightedCoverage = 0;
  let totalExpected = 0;
  let totalGap = 0;

  for (const [source, timestamps] of bySource) {
    const cadenceMs = estimateCadenceMs(timestamps);
    const expected = Math.max(1, Math.round(windowMs / cadenceMs));
    const received = timestamps.length;
    const coverage = Math.min(1, received / expected);
    const gap = Math.max(0, expected - received);

    perSource.push({ source, expected, received, coverage, gap, cadenceMs });
    weightedCoverage += coverage * expected;
    totalExpected += expected;
    totalGap += gap;
  }

  const aggregateCoverage = totalExpected > 0 ? weightedCoverage / totalExpected : 0;

  return { windowMs, perSource, aggregateCoverage, totalGap };
}

/**
 * Fold coverage into a base confidence score. A starved aggregate
 * (low coverage) reports lower confidence. Coverage acts as a
 * multiplicative penalty so a fully covered aggregate is unchanged.
 */
export function applyCoverageToConfidence(
  baseConfidence: number,
  coverage: number,
): number {
  const clamped = Math.max(0, Math.min(1, coverage));
  const penalized = baseConfidence * clamped;
  return Math.max(0, Math.min(1, penalized));
}
