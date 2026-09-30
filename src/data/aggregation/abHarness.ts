/**
 * Aggregation algorithm registry: pluggable strategies with an A/B harness.
 *
 * Pure-core guarantee (#605): every strategy is side-effect free and uses
 * exact arithmetic (integer/rational math only, no floating point).
 */

/** A single observation used as input to an aggregation strategy. */
export interface Observation {
  /** Exact value as a rational: numerator / denominator (denominator > 0). */
  numerator: bigint;
  denominator: bigint;
  /** Timestamp in milliseconds since epoch, used by time-weighted strategies. */
  timestamp: number;
  /** Optional reputation weight (exact rational) for reputation-weighted strategies. */
  weightNumerator?: bigint;
  weightDenominator?: bigint;
}

/** Exact rational result of an aggregation. */
export interface AggregationResult {
  numerator: bigint;
  denominator: bigint;
}

/**
 * Pluggable aggregation strategy. Implementations MUST be side-effect free and
 * MUST use exact arithmetic only (no Number/float math).
 */
export interface AggregationStrategy {
  /** Stable identifier used for config/feature-flag selection. */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** Aggregate observations into a single exact rational value. */
  aggregate(observations: readonly Observation[]): AggregationResult;
}

/** Greatest common divisor for bigints (Euclid). */
function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Reduce an exact rational to lowest terms with a positive denominator. */
function reduce(numerator: bigint, denominator: bigint): AggregationResult {
  if (denominator === 0n) {
    throw new Error('aggregation: zero denominator');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g === 0n) {
    return { numerator: 0n, denominator: 1n };
  }
  return { numerator: n / g, denominator: d / g };
}

/** Compare two exact rationals: -1, 0, or 1. */
function compare(a: AggregationResult, b: AggregationResult): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Median strategy: exact middle value of the sorted observations. */
export const medianStrategy: AggregationStrategy = {
  id: 'median',
  description: 'Exact median of the observed values.',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('median: no observations');
    }
    const sorted = observations
      .map((o) => reduce(o.numerator, o.denominator))
      .sort(compare);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[mid];
    }
    const a = sorted[mid - 1];
    const b = sorted[mid];
    return reduce(
      a.numerator * b.denominator + b.numerator * a.denominator,
      a.denominator * b.denominator * 2n,
    );
  },
};

/** Time-weighted average price: weights each observation by its time span. */
export const twapStrategy: AggregationStrategy = {
  id: 'twap',
  description: 'Time-weighted average price over the observation window.',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('twap: no observations');
    }
    const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length === 1) {
      return reduce(sorted[0].numerator, sorted[0].denominator);
    }
    let weightedNum = 0n;
    let weightedDen = 1n;
    let totalSpan = 0n;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const span = BigInt(sorted[i + 1].timestamp - sorted[i].timestamp);
      if (span <= 0n) continue;
      const value = reduce(sorted[i].numerator, sorted[i].denominator);
      // weightedNum/weightedDen += value * span
      weightedNum = weightedNum * value.denominator + value.numerator * span * weightedDen;
      weightedDen = weightedDen * value.denominator;
      totalSpan += span;
    }
    if (totalSpan === 0n) {
      return reduce(sorted[sorted.length - 1].numerator, sorted[sorted.length - 1].denominator);
    }
    return reduce(weightedNum, weightedDen * totalSpan);
  },
};

/** Reputation-weighted strategy: weights each observation by its reputation. */
export const reputationWeightedStrategy: AggregationStrategy = {
  id: 'reputation-weighted',
  description: 'Reputation-weighted average of the observed values.',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('reputation-weighted: no observations');
    }
    let weightedNum = 0n;
    let weightedDen = 1n;
    let totalWeightNum = 0n;
    let totalWeightDen = 1n;
    for (const o of observations) {
      const value = reduce(o.numerator, o.denominator);
      const wNum = o.weightNumerator ?? 1n;
      const wDen = o.weightDenominator ?? 1n;
      if (wDen === 0n) {
        throw new Error('reputation-weighted: zero weight denominator');
      }
      // weighted += value * (wNum / wDen)
      weightedNum = weightedNum * value.denominator * wDen + value.numerator * wNum * weightedDen;
      weightedDen = weightedDen * value.denominator * wDen;
      // totalWeight += wNum / wDen
      totalWeightNum = totalWeightNum * wDen + wNum * totalWeightDen;
      totalWeightDen = totalWeightDen * wDen;
    }
    if (totalWeightNum === 0n) {
      throw new Error('reputation-weighted: total weight is zero');
    }
    return reduce(weightedNum * totalWeightDen, weightedDen * totalWeightNum);
  },
};

/** Registry of interchangeable aggregation strategies, keyed by id. */
export class AggregationStrategyRegistry {
  private readonly strategies = new Map<string, AggregationStrategy>();

  constructor(strategies: readonly AggregationStrategy[] = []) {
    for (const strategy of strategies) {
      this.register(strategy);
    }
  }

  register(strategy: AggregationStrategy): void {
    if (this.strategies.has(strategy.id)) {
      throw new Error(`aggregation: strategy already registered: ${strategy.id}`);
    }
    this.strategies.set(strategy.id, strategy);
  }

  get(id: string): AggregationStrategy {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error(`aggregation: unknown strategy: ${id}`);
    }
    return strategy;
  }

  has(id: string): boolean {
    return this.strategies.has(id);
  }

  ids(): string[] {
    return [...this.strategies.keys()];
  }
}

/** Default registry with the built-in strategies pre-registered. */
export function createDefaultRegistry(): AggregationStrategyRegistry {
  return new AggregationStrategyRegistry([
    medianStrategy,
    twapStrategy,
    reputationWeightedStrategy,
  ]);
}

/**
 * Resolve the active strategy from config/feature-flag input without code
 * changes. Accepts a strategy id or an object with a `strategy` field.
 */
export function selectStrategy(
  config: string | { strategy?: string } | undefined,
  registry: AggregationStrategyRegistry = createDefaultRegistry(),
): AggregationStrategy {
  const id = typeof config === 'string' ? config : config?.strategy;
  return registry.get(id ?? 'median');
}

/** Reference oracle used to score strategies in the A/B harness. */
export interface ReferenceOracle {
  /** Exact reference value for a given observation window. */
  reference(observations: readonly Observation[]): AggregationResult;
}

/** Score of a single strategy against the reference oracle. */
export interface StrategyScore {
  strategyId: string;
  /** Number of replayed windows scored. */
  windows: number;
  /** Sum of absolute exact errors (as a rational). */
  totalError: AggregationResult;
  /** Mean absolute exact error (as a rational). */
  meanError: AggregationResult;
}

/** A replayed history window fed to the A/B harness. */
export interface ReplayWindow {
  observations: readonly Observation[];
}

/** Absolute difference between two exact rationals. */
function absDiff(a: AggregationResult, b: AggregationResult): AggregationResult {
  const diff = reduce(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
  return diff.numerator < 0n
    ? { numerator: -diff.numerator, denominator: diff.denominator }
    : diff;
}

/**
 * A/B harness: scores each candidate strategy against the reference oracle over
 * replayed history. Pure and side-effect free.
 */
export function scoreStrategies(
  strategies: readonly AggregationStrategy[],
  windows: readonly ReplayWindow[],
  oracle: ReferenceOracle,
): StrategyScore[] {
  return strategies.map((strategy) => {
    let totalNum = 0n;
    let totalDen = 1n;
    for (const window of windows) {
      const actual = strategy.aggregate(window.observations);
      const expected = oracle.reference(window.observations);
      const error = absDiff(actual, expected);
      totalNum = totalNum * error.denominator + error.numerator * totalDen;
      totalDen = totalDen * error.denominator;
    }
    const totalError = reduce(totalNum, totalDen);
    const meanError =
      windows.length === 0
        ? { numerator: 0n, denominator: 1n }
        : reduce(totalError.numerator, totalError.denominator * BigInt(windows.length));
    return {
      strategyId: strategy.id,
      windows: windows.length,
      totalError,
      meanError,
    };
  });
}

/** Rank scores from best (lowest mean error) to worst. */
export function rankScores(scores: readonly StrategyScore[]): StrategyScore[] {
  return [...scores].sort((a, b) => compare(a.meanError, b.meanError));
}
