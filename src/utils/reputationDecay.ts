/**
 * @file Pure helpers for reputation decay and sybil resistance (#697).
 *
 * A reputation score that only ever accumulates rewards incumbents forever and
 * provides no defence against coordinated fake sources inflating their
 * influence. This module surfaces the aggregator's decay metadata and sybil
 * risk signals in a form the UI can display safely.
 *
 * Trust rules:
 * 1. Never compute an effective score from scratch — the aggregator's reported
 *    `score` is authoritative. These helpers only format and classify the data.
 * 2. Never hide null scores as zero. A source that has not been scored yet is
 *    different from a source with zero reputation.
 * 3. Never rewrite sybilRisk values. The classification is reported by the
 *    aggregator; the client displays it verbatim.
 */
import type { SourceReputationScore, SybilRisk } from '../types'

/** Human-readable label for each sybil risk tier. */
export const SYBIL_RISK_LABELS: Record<SybilRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  unknown: 'Risk unknown',
}

/** Tailwind colour utility classes for each sybil risk tier. */
export const SYBIL_RISK_STYLES: Record<SybilRisk, string> = {
  low: 'text-green-400 bg-green-500/10 border-green-500/30',
  medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  high: 'text-red-400 bg-red-500/10 border-red-500/30',
  unknown: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
}

/**
 * Formats a reputation score [0, 1] as a percentage string with one decimal
 * place, e.g. `"87.3 %"`. Returns `null` when the score is null (not reported).
 *
 * Do **not** substitute "0 %" for null — that reads as a source that has been
 * scored and found to have zero reputation, which is not the same as unscored.
 */
export function formatReputationScore(score: number | null): string | null {
  if (score === null) return null
  return `${(score * 100).toFixed(1)} %`
}

/**
 * Estimates the projected score at a future point in time using exponential
 * decay from the last known score.
 *
 * score(t) = lastScore × 0.5^(elapsed / halfLife)
 *
 * Returns `null` when any required input is null. This is a **display
 * projection only** — the aggregator's next reported score is authoritative.
 */
export function projectDecayedScore(
  lastScore: number | null,
  lastScoredAt: number | null,
  decayHalfLifeMs: number,
  now: number = Date.now(),
): number | null {
  if (lastScore === null || lastScoredAt === null) return null
  if (decayHalfLifeMs <= 0) return null
  const elapsed = Math.max(0, now - lastScoredAt)
  return lastScore * Math.pow(0.5, elapsed / decayHalfLifeMs)
}

/**
 * Effective score after applying the sybil attenuation factor.
 *
 * effectiveScore = score × sybilAttenuationFactor
 *
 * Returns `null` when the base score is not reported.
 */
export function effectiveScore(rep: SourceReputationScore): number | null {
  if (rep.score === null) return null
  return rep.score * rep.sybilAttenuationFactor
}

/**
 * Fraction of decay consumed since the last scoring event.
 * Concretely: what fraction of the half-life period has elapsed.
 * Returns `null` when `lastScoredAt` is null; clamped to [0, 1].
 *
 * Useful for a "freshness" progress bar: 0 → just scored, 1 → one half-life
 * elapsed (score has halved).
 */
export function decayFraction(
  lastScoredAt: number | null,
  decayHalfLifeMs: number,
  now: number = Date.now(),
): number | null {
  if (lastScoredAt === null) return null
  if (decayHalfLifeMs <= 0) return null
  const elapsed = Math.max(0, now - lastScoredAt)
  return Math.min(1, elapsed / decayHalfLifeMs)
}

/**
 * Sorts reputation scores for leaderboard display:
 *   1. By effective score descending (null scores placed last).
 *   2. For equal effective scores, by sybilRisk ascending (low risk first).
 *   3. Ties broken by sourceId lexicographically for determinism.
 */
export function rankByEffectiveScore(scores: readonly SourceReputationScore[]): SourceReputationScore[] {
  const RISK_ORDER: Record<SybilRisk, number> = { low: 0, medium: 1, unknown: 2, high: 3 }
  return [...scores].sort((a, b) => {
    const ea = effectiveScore(a)
    const eb = effectiveScore(b)
    if (ea === null && eb === null) return a.sourceId.localeCompare(b.sourceId)
    if (ea === null) return 1
    if (eb === null) return -1
    if (eb !== ea) return eb - ea
    const riskDiff = RISK_ORDER[a.sybilRisk] - RISK_ORDER[b.sybilRisk]
    if (riskDiff !== 0) return riskDiff
    return a.sourceId.localeCompare(b.sourceId)
  })
}

/**
 * Returns sources that share the same sybil cluster (i.e. all sources in
 * the same cluster as `sourceId`, excluding `sourceId` itself).
 * Returns an empty array when the source has no cluster.
 */
export function sybilClusterPeers(
  scores: readonly SourceReputationScore[],
  sourceId: string,
): SourceReputationScore[] {
  const target = scores.find((s) => s.sourceId === sourceId)
  if (!target || target.sybilClusterId === null) return []
  return scores.filter((s) => s.sourceId !== sourceId && s.sybilClusterId === target.sybilClusterId)
}
