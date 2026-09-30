/**
 * @file Pure helpers for the dispute and challenge process (#695).
 *
 * When sources disagree and the aggregate is contested, this module provides
 * the helpers needed to display disputes, evidence, and resolutions — creating
 * an on-platform record that replaces off-platform discussion and leaves no
 * gaps.
 *
 * Trust rules:
 * 1. Never fabricate a resolution. A dispute with status `'open'` is ongoing
 *    regardless of what the local clock says; the client never infers an outcome.
 * 2. Display `resolutionNote` verbatim when present. Do not summarise or trim.
 * 3. Never rewrite `status`. The aggregator is the source of truth.
 */
import type { DisputeStatus, PriceDispute } from '../types'

/** Human-readable label for each dispute status. */
export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Open',
  under_review: 'Under review',
  resolved_upheld: 'Resolved — price upheld',
  resolved_overturned: 'Resolved — price overturned',
  withdrawn: 'Withdrawn',
}

/** Tailwind colour utility classes for each dispute status. */
export const DISPUTE_STATUS_STYLES: Record<DisputeStatus, string> = {
  open: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30',
  under_review: 'text-yellow-300 bg-yellow-500/15 border-yellow-500/30',
  resolved_upheld: 'text-green-300 bg-green-500/15 border-green-500/30',
  resolved_overturned: 'text-red-300 bg-red-500/15 border-red-500/30',
  withdrawn: 'text-gray-400 bg-gray-500/15 border-gray-500/30',
}

/** Returns true when the dispute is in a terminal (closed) state. */
export function isDisputeResolved(dispute: PriceDispute): boolean {
  return (
    dispute.status === 'resolved_upheld' ||
    dispute.status === 'resolved_overturned' ||
    dispute.status === 'withdrawn'
  )
}

/**
 * Returns true when the resolution deadline has passed without resolution.
 * Never rewrites `status` — this is a caveat flag for the UI.
 */
export function isDeadlineBreached(dispute: PriceDispute, now: number = Date.now()): boolean {
  if (dispute.resolutionDeadline === null) return false
  if (isDisputeResolved(dispute)) return false
  return now > dispute.resolutionDeadline
}

/**
 * Sorts disputes for display:
 *   1. Open disputes first, then under_review, then resolved/withdrawn.
 *   2. Within open/under_review: soonest deadline first; no-deadline last.
 *   3. Within resolved: most recent `openedAt` first.
 *   4. Ties broken by `id` for determinism.
 */
export function orderDisputes(disputes: readonly PriceDispute[]): PriceDispute[] {
  const statusRank = (status: DisputeStatus): number => {
    if (status === 'open') return 0
    if (status === 'under_review') return 1
    return 2
  }
  return [...disputes].sort((a, b) => {
    const rankDiff = statusRank(a.status) - statusRank(b.status)
    if (rankDiff !== 0) return rankDiff
    if (!isDisputeResolved(a)) {
      // Active disputes: soonest deadline first, no-deadline last
      const ad = a.resolutionDeadline ?? Number.POSITIVE_INFINITY
      const bd = b.resolutionDeadline ?? Number.POSITIVE_INFINITY
      if (ad !== bd) return ad - bd
    } else {
      // Resolved disputes: most recently opened first
      const diff = b.openedAt - a.openedAt
      if (diff !== 0) return diff
    }
    return a.id.localeCompare(b.id)
  })
}

/**
 * Filters disputes to those that concern a specific asset pair.
 * Matching is case-insensitive to tolerate formatting differences.
 */
export function filterByAssetPair(disputes: readonly PriceDispute[], pair: string): PriceDispute[] {
  const lower = pair.toLowerCase()
  return disputes.filter((d) => d.assetPair.toLowerCase() === lower)
}

/**
 * Filters disputes to those that implicate a given source.
 * Matching is case-insensitive.
 */
export function filterByImplicatedSource(disputes: readonly PriceDispute[], sourceId: string): PriceDispute[] {
  const lower = sourceId.toLowerCase()
  return disputes.filter((d) => d.impliedSources.some((s) => s.toLowerCase() === lower))
}

/**
 * Returns the number of open (unresolved) disputes across the list.
 * Used for the open-dispute count badge in the governance header.
 */
export function openDisputeCount(disputes: readonly PriceDispute[]): number {
  return disputes.filter((d) => !isDisputeResolved(d)).length
}

/**
 * Returns a summary string for the evidence count on a dispute, suitable for
 * an aria-label. Examples: "1 piece of evidence", "3 pieces of evidence".
 */
export function evidenceCountLabel(dispute: PriceDispute): string {
  const n = dispute.evidence.length
  return n === 1 ? '1 piece of evidence' : `${n} pieces of evidence`
}
