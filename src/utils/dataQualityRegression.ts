/**
 * @file Per-pair data-quality history and regression detection (#644).
 *
 * History is persisted in the bounded time-series store (series `data-quality:<pair>`,
 * see `DATA_QUALITY_SERIES`); retention/rollups are the store's. Detection is a pure,
 * deterministic function of the history: a pair is flagged when its recent mean score
 * falls below the rolling baseline mean by more than `max(minDrop, sigmaBound * stddev)`.
 */
import { SERIES_IDS, timeSeries } from '../storage/timeseries'
import type { DataQualityPayload } from '../storage/timeseries/config'
import type { QualityFactors } from './dataQualityScore'

export interface QualitySnapshot {
  t: number
  score: number
  factors: QualityFactors
  sources: string[]
}

export interface RegressionOptions {
  /** Number of most recent snapshots forming the "current" window. */
  recentWindow: number
  /** Minimum baseline snapshots required to judge. */
  minBaseline: number
  /** Drop must exceed this many baseline standard deviations. */
  sigmaBound: number
  /** ...and at least this many score points. */
  minDrop: number
}

export const DEFAULT_REGRESSION_OPTIONS: RegressionOptions = {
  recentWindow: 5,
  minBaseline: 10,
  sigmaBound: 2,
  minDrop: 5,
}

export type FactorName = keyof QualityFactors

export interface RegressionResult {
  pair: string
  flagged: boolean
  baselineMean: number
  recentMean: number
  drop: number
  threshold: number
  /** Factors whose recent mean dropped most, worst first (drop > 0 only). */
  worstFactors: Array<{ factor: FactorName; drop: number }>
  /** Sources seen in the recent window, for triage; sources missing vs baseline are marked. */
  sources: Array<{ source: string; missingRecently: boolean }>
}

const mean = (v: readonly number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const stddev = (v: readonly number[]) => {
  const m = mean(v)
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)))
}

/**
 * Pure regression check. `history` is sorted internally by time; no clock or randomness
 * is used, so results are reproducible. Returns `null` when the baseline is too short.
 */
export function detectQualityRegression(
  pair: string,
  history: readonly QualitySnapshot[],
  options: Partial<RegressionOptions> = {},
): RegressionResult | null {
  const o = { ...DEFAULT_REGRESSION_OPTIONS, ...options }
  const sorted = [...history].sort((a, b) => a.t - b.t)
  const recent = sorted.slice(-o.recentWindow)
  const baseline = sorted.slice(0, sorted.length - recent.length)
  if (baseline.length < o.minBaseline || recent.length < o.recentWindow) return null

  const baselineMean = mean(baseline.map((s) => s.score))
  const recentMean = mean(recent.map((s) => s.score))
  const threshold = Math.max(o.minDrop, o.sigmaBound * stddev(baseline.map((s) => s.score)))
  const drop = baselineMean - recentMean

  const factors: FactorName[] = ['freshness', 'confidence', 'deviation', 'sourceCoverage']
  const worstFactors = factors
    .map((factor) => ({
      factor,
      drop: mean(baseline.map((s) => s.factors[factor])) - mean(recent.map((s) => s.factors[factor])),
    }))
    .filter((f) => f.drop > 0)
    .sort((a, b) => b.drop - a.drop || a.factor.localeCompare(b.factor))

  const recentSources = new Set(recent.flatMap((s) => s.sources))
  const baselineSources = new Set(baseline.flatMap((s) => s.sources))
  const sources = [...new Set([...recentSources, ...baselineSources])]
    .sort()
    .map((source) => ({ source, missingRecently: !recentSources.has(source) }))

  return { pair, flagged: drop > threshold, baselineMean, recentMean, drop, threshold, worstFactors, sources }
}

/** Persists one quality snapshot for a pair (best-effort, per the store's contract). */
export function recordQualitySnapshot(payload: DataQualityPayload): Promise<void> {
  return timeSeries.append(SERIES_IDS.dataQuality(payload.assetPair), payload)
}

/** Loads a pair's stored history over `[from, to]` and converts it to snapshots. */
export async function loadQualityHistory(pair: string, from: number, to: number): Promise<QualitySnapshot[]> {
  const points = await timeSeries.query({ series: SERIES_IDS.dataQuality(pair), from, to, tier: 'raw' })
  return points.map((p) => {
    const meta = (p as { meta?: { factors?: QualityFactors; sources?: string[] } }).meta
    return {
      t: p.t,
      score: p.v,
      factors: meta?.factors ?? { freshness: p.v, confidence: p.v, deviation: p.v, sourceCoverage: p.v },
      sources: meta?.sources ?? [],
    }
  })
}

/** Runs detection over several pairs and returns only flagged ones, worst drop first. */
export async function flaggedPairs(
  pairs: readonly string[],
  now: number,
  windowMs: number,
  options?: Partial<RegressionOptions>,
): Promise<RegressionResult[]> {
  const results = await Promise.all(
    pairs.map(async (pair) => detectQualityRegression(pair, await loadQualityHistory(pair, now - windowMs, now), options)),
  )
  return results.filter((r): r is RegressionResult => r !== null && r.flagged).sort((a, b) => b.drop - a.drop)
}
