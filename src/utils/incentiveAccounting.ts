/**
 * @file Pure helpers for treasury and incentive accounting (#696).
 *
 * Reputation and staking imply incentives, but there is no accounting for who
 * is owed what based on contribution, uptime, and accuracy. This module helps
 * display the aggregator-reported ledger data so the incentive programme is
 * not arbitrary.
 *
 * Trust rules (shared with the rest of the governance layer):
 * 1. All amounts are strings reported by the API. We never do arithmetic on
 *    them — floating-point precision on reward amounts is a governance risk.
 * 2. Never fabricate a balance. A null cumulative balance is displayed as
 *    "not reported", not as zero.
 * 3. Never re-sort ledger entries. The API guarantees sequence-number order;
 *    re-sorting client-side would be misleading if the server later reports a
 *    correction entry.
 */
import type { IncentiveLedgerEntry, SourceIncentiveSummary } from '../types'

/** Human-readable label for each reward type. */
export const REWARD_TYPE_LABELS: Record<IncentiveLedgerEntry['rewardType'], string> = {
  accuracy: 'Accuracy reward',
  uptime: 'Uptime reward',
  latency: 'Latency reward',
  staking: 'Staking reward',
  slash: 'Slash (penalty)',
}

/** Whether a ledger entry is a credit (positive) or a debit/penalty. */
export function isCredit(entry: IncentiveLedgerEntry): boolean {
  return entry.rewardType !== 'slash'
}

/**
 * Filters ledger entries by reward type.
 * Returns all entries when `type` is not provided, preserving sequence order.
 */
export function filterLedger(
  entries: readonly IncentiveLedgerEntry[],
  type?: IncentiveLedgerEntry['rewardType'],
): IncentiveLedgerEntry[] {
  if (type === undefined) return [...entries]
  return entries.filter((e) => e.rewardType === type)
}

/**
 * Returns the most recent ledger entry in a summary (highest `seq`), or null
 * when the ledger is empty. Does not sort — the API guarantees sequence order.
 */
export function latestLedgerEntry(summary: SourceIncentiveSummary): IncentiveLedgerEntry | null {
  if (summary.ledger.length === 0) return null
  return summary.ledger[summary.ledger.length - 1]
}

/**
 * Counts the number of slash events in a ledger.
 * Useful for surfacing sources with a poor slash history without hiding
 * the individual amounts.
 */
export function slashCount(summary: SourceIncentiveSummary): number {
  return summary.ledger.filter((e) => e.rewardType === 'slash').length
}

/**
 * Finds the summary with the highest reported `totalEarned` amount.
 * Comparison is lexicographic on the string representation, which is correct
 * only when all amounts use the same denomination and precision.
 *
 * When the precision is heterogeneous across summaries, the caller should
 * normalise before passing in. Returns `null` for an empty array.
 */
export function topEarner(summaries: readonly SourceIncentiveSummary[]): SourceIncentiveSummary | null {
  if (summaries.length === 0) return null
  return summaries.reduce((best, current) => {
    // Parse as floats only for comparison; never use the result as a display value.
    const bestVal = parseFloat(best.totalEarned)
    const currentVal = parseFloat(current.totalEarned)
    if (isNaN(currentVal)) return best
    if (isNaN(bestVal)) return current
    return currentVal > bestVal ? current : best
  })
}

/**
 * Groups summaries by their `period` field.
 * Returns a Map keyed by period, with arrays in input order.
 */
export function groupByPeriod(
  summaries: readonly SourceIncentiveSummary[],
): Map<SourceIncentiveSummary['period'], SourceIncentiveSummary[]> {
  const result = new Map<SourceIncentiveSummary['period'], SourceIncentiveSummary[]>()
  for (const s of summaries) {
    const existing = result.get(s.period)
    if (existing) {
      existing.push(s)
    } else {
      result.set(s.period, [s])
    }
  }
  return result
}

/**
 * Returns true when a source had any slash event in the given summary period.
 * Used to flag sources in the accounting UI without hiding the full ledger.
 */
export function wasSlashedThisPeriod(summary: SourceIncentiveSummary): boolean {
  return slashCount(summary) > 0
}
