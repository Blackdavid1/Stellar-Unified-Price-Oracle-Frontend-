/**
 * Reference-price oracle for ground-truth cross-checks.
 *
 * This module integrates an INDEPENDENT benchmark price source that is used
 * purely for evaluation of the aggregation pipeline. It is:
 *   - read-only (never written back into the aggregate),
 *   - excluded from the aggregate computation,
 *   - never surfaced as a tradable price.
 *
 * It exists so quality metrics can be compared against a source that does not
 * share the inputs of the aggregate, making systematic bias visible.
 */

export interface ReferencePricePoint {
  /** ISO-8601 timestamp of the observation. */
  timestamp: string;
  /** Benchmark price. NOT a tradable price. */
  price: number;
  /** Identifier of the independent benchmark source. */
  source: string;
}

/**
 * A read-only provider of independent benchmark prices.
 * Implementations must never mutate aggregate state.
 */
export interface ReferencePriceSource {
  readonly id: string;
  /** Human-readable label, always presented as a benchmark. */
  readonly label: string;
  /** Fetch benchmark observations for a window. Read-only. */
  fetch(symbol: string, from: string, to: string): Promise<ReferencePricePoint[]>;
}

/**
 * Deviation of the aggregate from the independent reference at a point in time.
 * Positive => aggregate is above the benchmark.
 */
export interface DeviationPoint {
  timestamp: string;
  aggregate: number;
  reference: number;
  /** (aggregate - reference) / reference */
  deviation: number;
}

/**
 * Sustained-bias alert emitted when the rolling mean deviation exceeds a
 * configurable threshold for a configurable number of consecutive windows.
 */
export interface BiasAlert {
  symbol: string;
  /** Rolling mean deviation that triggered the alert. */
  meanDeviation: number;
  /** Configured threshold that was exceeded. */
  threshold: number;
  /** Number of consecutive windows above threshold. */
  consecutiveWindows: number;
  /** Timestamp of the most recent window in the run. */
  timestamp: string;
}

export interface BiasThresholds {
  /** Absolute mean deviation above which a window counts as biased. */
  deviationThreshold: number;
  /** Consecutive biased windows required before alerting. */
  consecutiveWindows: number;
}

export const DEFAULT_BIAS_THRESHOLDS: BiasThresholds = {
  deviationThreshold: 0.02,
  consecutiveWindows: 3,
};

/**
 * Compute aggregate-vs-reference deviation over time.
 *
 * The reference is matched to the aggregate by timestamp; unmatched points are
 * skipped so the reference never influences the aggregate itself.
 */
export function computeDeviationSeries(
  aggregate: ReferencePricePoint[],
  reference: ReferencePricePoint[],
): DeviationPoint[] {
  const referenceByTime = new Map<string, number>();
  for (const point of reference) {
    referenceByTime.set(point.timestamp, point.price);
  }

  const series: DeviationPoint[] = [];
  for (const point of aggregate) {
    const refPrice = referenceByTime.get(point.timestamp);
    if (refPrice === undefined || refPrice === 0) {
      continue;
    }
    series.push({
      timestamp: point.timestamp,
      aggregate: point.price,
      reference: refPrice,
      deviation: (point.price - refPrice) / refPrice,
    });
  }
  return series;
}

/**
 * Track deviation over time and alert on sustained bias.
 *
 * A window is "biased" when |mean deviation| exceeds the threshold. An alert is
 * emitted once `consecutiveWindows` biased windows occur in a row.
 */
export function detectSustainedBias(
  symbol: string,
  series: DeviationPoint[],
  thresholds: BiasThresholds = DEFAULT_BIAS_THRESHOLDS,
): BiasAlert[] {
  const alerts: BiasAlert[] = [];
  let run: DeviationPoint[] = [];

  for (const point of series) {
    if (Math.abs(point.deviation) > thresholds.deviationThreshold) {
      run.push(point);
      if (run.length >= thresholds.consecutiveWindows) {
        const meanDeviation =
          run.reduce((sum, p) => sum + p.deviation, 0) / run.length;
        alerts.push({
          symbol,
          meanDeviation,
          threshold: thresholds.deviationThreshold,
          consecutiveWindows: run.length,
          timestamp: point.timestamp,
        });
      }
    } else {
      run = [];
    }
  }

  return alerts;
}

/**
 * Score an aggregation strategy against the independent reference.
 * Lower mean absolute deviation is better. Used only for evaluation.
 */
export function scoreStrategy(
  aggregate: ReferencePricePoint[],
  reference: ReferencePricePoint[],
): { meanAbsDeviation: number; samples: number } {
  const series = computeDeviationSeries(aggregate, reference);
  if (series.length === 0) {
    return { meanAbsDeviation: Number.NaN, samples: 0 };
  }
  const meanAbsDeviation =
    series.reduce((sum, p) => sum + Math.abs(p.deviation), 0) / series.length;
  return { meanAbsDeviation, samples: series.length };
}

/**
 * Evaluate candidate outlier thresholds against the reference and return the
 * threshold whose filtered aggregate deviates least from the benchmark.
 */
export function evaluateOutlierThresholds(
  candidates: number[],
  buildAggregate: (threshold: number) => ReferencePricePoint[],
  reference: ReferencePricePoint[],
): { threshold: number; meanAbsDeviation: number } | null {
  let best: { threshold: number; meanAbsDeviation: number } | null = null;
  for (const threshold of candidates) {
    const { meanAbsDeviation, samples } = scoreStrategy(
      buildAggregate(threshold),
      reference,
    );
    if (samples === 0 || Number.isNaN(meanAbsDeviation)) {
      continue;
    }
    if (best === null || meanAbsDeviation < best.meanAbsDeviation) {
      best = { threshold, meanAbsDeviation };
    }
  }
  return best;
}

/**
 * UI-facing label. The reference is a benchmark, never a tradable price.
 */
export const REFERENCE_BENCHMARK_LABEL =
  'Benchmark reference (evaluation only \u2014 not a tradable price)';
