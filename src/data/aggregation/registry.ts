/**
 * Aggregation algorithm registry (#661).
 *
 * Pluggable aggregation strategies with an A/B harness. Every strategy is a
 * pure, side-effect-free function over exact-arithmetic inputs (pure-core
 * guarantee #605): given the same observations it always returns the same
 * result and never mutates its arguments.
 */

/** A single price observation used by the aggregation strategies. */
export interface Observation {
  /** Exact price, expressed as a rational numerator/denominator pair. */
  readonly price: Rational;
  /** Observation timestamp in milliseconds since the epoch. */
  readonly timestamp: number;
  /** Optional reputation weight (used by the reputation-weighted strategy). */
  readonly reputation?: number;
}

/** Exact rational number: value === numerator / denominator. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * A pluggable aggregation strategy. Implementations MUST be pure: no I/O, no
 * mutation of the supplied observations, and exact arithmetic only.
 */
export interface AggregationStrategy {
  /** Stable identifier used for config/feature-flag selection. */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** Aggregate observations into a single exact price. */
  aggregate(observations: readonly Observation[]): Rational;
}

/** Greatest common divisor for bigints (Euclid). */
function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/** Construct a normalized (reduced, positive-denominator) rational. */
function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new Error('aggregation: zero denominator');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { numerator: n / g, denominator: d / g };
}

/** Exact comparison of two rationals. */
function compare(a: Rational, b: Rational): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Exact addition of two rationals. */
function add(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

/** Exact division of two rationals. */
function divide(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

/**
 * Median strategy: the middle observation by price (mean of the two middle
 * values for an even count). Exact arithmetic, no floating point.
 */
export const medianStrategy: AggregationStrategy = {
  id: 'median',
  description: 'Median of observed prices',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('median: no observations');
    }
    const sorted = [...observations].sort((a, b) => compare(a.price, b.price));
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[mid].price;
    }
    return divide(add(sorted[mid - 1].price, sorted[mid].price), rational(2n, 1n));
  },
};

/**
 * TWAP strategy: time-weighted average price. Each observation is weighted by
 * the interval it covers, using exact rational arithmetic throughout.
 */
export const twapStrategy: AggregationStrategy = {
  id: 'twap',
  description: 'Time-weighted average price',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('twap: no observations');
    }
    const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length === 1) {
      return sorted[0].price;
    }
    let weighted = rational(0n, 1n);
    let totalWeight = 0n;
    for (let i = 1; i < sorted.length; i += 1) {
      const weight = BigInt(sorted[i].timestamp - sorted[i - 1].timestamp);
      if (weight <= 0n) {
        continue;
      }
      weighted = add(weighted, {
        numerator: sorted[i - 1].price.numerator * weight,
        denominator: sorted[i - 1].price.denominator,
      });
      totalWeight += weight;
    }
    if (totalWeight === 0n) {
      return sorted[sorted.length - 1].price;
    }
    return divide(weighted, rational(totalWeight, 1n));
  },
};

/**
 * Reputation-weighted strategy (#523): each observation is weighted by its
 * reputation score. Missing reputation defaults to 1.
 */
export const reputationWeightedStrategy: AggregationStrategy = {
  id: 'reputation-weighted',
  description: 'Reputation-weighted average price',
  aggregate(observations) {
    if (observations.length === 0) {
      throw new Error('reputation-weighted: no observations');
    }
    let weighted = rational(0n, 1n);
    let totalWeight = 0n;
    for (const observation of observations) {
      const weight = BigInt(Math.max(0, Math.trunc(observation.reputation ?? 1)));
      if (weight <= 0n) {
        continue;
      }
      weighted = add(weighted, {
        numerator: observation.price.numerator * weight,
        denominator: observation.price.denominator,
      });
      totalWeight += weight;
    }
    if (totalWeight === 0n) {
      throw new Error('reputation-weighted: total weight is zero');
    }
    return divide(weighted, rational(totalWeight, 1n));
  },
};

/** Registry of available strategies, keyed by their stable id. */
const registry = new Map<string, AggregationStrategy>();

/** Register a strategy so it can be selected by id. */
export function registerStrategy(strategy: AggregationStrategy): void {
  registry.set(strategy.id, strategy);
}

/** List all registered strategies. */
export function listStrategies(): AggregationStrategy[] {
  return [...registry.values()];
}

/**
 * Resolve a strategy by id, falling back to the configured default when the id
 * is unknown. Selection is driven entirely by config/feature flags, so callers
 * never need code changes to switch strategies.
 */
export function resolveStrategy(id?: string): AggregationStrategy {
  if (id && registry.has(id)) {
    return registry.get(id) as AggregationStrategy;
  }
  return registry.get(DEFAULT_STRATEGY_ID) as AggregationStrategy;
}

/** Default strategy id, overridable via the AGGREGATION_STRATEGY env var. */
export const DEFAULT_STRATEGY_ID =
  (typeof process !== 'undefined' && process.env?.AGGREGATION_STRATEGY) || 'median';

registerStrategy(medianStrategy);
registerStrategy(twapStrategy);
registerStrategy(reputationWeightedStrategy);

/** A single replayed history point used by the A/B harness. */
export interface ReplayPoint {
  readonly observations: readonly Observation[];
  /** Reference oracle price for this point (#new). */
  readonly reference: Rational;
}

/** Score for one strategy over a replayed history. */
export interface StrategyScore {
  readonly strategyId: string;
  /** Number of replay points scored. */
  readonly samples: number;
  /** Mean absolute error against the reference oracle, as an exact rational. */
  readonly meanAbsoluteError: Rational;
}

/** Absolute difference between two rationals. */
function absDifference(a: Rational, b: Rational): Rational {
  const diff = add(a, { numerator: -b.numerator, denominator: b.denominator });
  return diff.numerator < 0n
    ? { numerator: -diff.numerator, denominator: diff.denominator }
    : diff;
}

/**
 * A/B harness: score every registered strategy against the reference oracle
 * over replayed history. Pure and deterministic; does not mutate inputs.
 */
export function scoreStrategies(history: readonly ReplayPoint[]): StrategyScore[] {
  return listStrategies().map((strategy) => {
    let totalError = rational(0n, 1n);
    let samples = 0;
    for (const point of history) {
      if (point.observations.length === 0) {
        continue;
      }
      const result = strategy.aggregate(point.observations);
      totalError = add(totalError, absDifference(result, point.reference));
      samples += 1;
    }
    return {
      strategyId: strategy.id,
      samples,
      meanAbsoluteError:
        samples === 0 ? rational(0n, 1n) : divide(totalError, rational(BigInt(samples), 1n)),
    };
  });
}

/**
 * Run the A/B harness and return the best-scoring strategy id, or the default
 * when there is no history to score against.
 */
export function selectBestStrategy(history: readonly ReplayPoint[]): string {
  const scores = scoreStrategies(history).filter((score) => score.samples > 0);
  if (scores.length === 0) {
    return DEFAULT_STRATEGY_ID;
  }
  return scores.reduce((best, current) =>
    compare(current.meanAbsoluteError, best.meanAbsoluteError) < 0 ? current : best,
  ).strategyId;
}
