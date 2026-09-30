/**
 * @file IncentiveLedgerPanel (#696)
 *
 * Shows treasury and incentive accounting for source operators: earned rewards,
 * slashes, net change, and the full per-period ledger — making the incentive
 * programme auditable rather than arbitrary.
 *
 * Rendering rules:
 * - All amounts are displayed as reported (strings). Never do arithmetic for
 *   display — fp representation is a governance risk.
 * - A null cumulative balance renders as "not reported", not zero.
 * - Slash events are highlighted so they are never visually buried.
 */
import { memo, useState, type ReactElement } from 'react'
import type { SourceIncentiveSummary, IncentiveLedgerEntry } from '../types'
import { REWARD_TYPE_LABELS, isCredit, slashCount, wasSlashedThisPeriod } from '../utils/incentiveAccounting'

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDateRange(start: number, end: number): string {
  return `${new Date(start).toLocaleDateString('en-US', { dateStyle: 'medium' })} – ${new Date(end).toLocaleDateString('en-US', { dateStyle: 'medium' })}`
}

interface LedgerEntryRowProps {
  entry: IncentiveLedgerEntry
}

const LedgerEntryRow = memo(function LedgerEntryRow({ entry }: LedgerEntryRowProps): ReactElement {
  const credit = isCredit(entry)
  return (
    <tr className={entry.rewardType === 'slash' ? 'bg-red-500/5' : undefined}>
      <td className="py-1.5 px-3 text-xs text-gray-500 tabular-nums whitespace-nowrap">{entry.seq}</td>
      <td className="py-1.5 px-3 text-xs text-gray-400 whitespace-nowrap">{formatTimestamp(entry.recordedAt)}</td>
      <td className="py-1.5 px-3 text-xs whitespace-nowrap">
        <span
          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${
            entry.rewardType === 'slash'
              ? 'text-red-300 bg-red-500/15 border-red-500/30'
              : 'text-green-300 bg-green-500/15 border-green-500/30'
          }`}
        >
          {REWARD_TYPE_LABELS[entry.rewardType]}
        </span>
      </td>
      <td className={`py-1.5 px-3 text-xs tabular-nums text-right font-mono ${credit ? 'text-green-400' : 'text-red-400'}`}>
        {credit ? '+' : ''}{entry.amount}
      </td>
      <td className="py-1.5 px-3 text-xs tabular-nums text-right font-mono text-gray-300">
        {entry.runningBalance}
      </td>
      <td className="py-1.5 px-3 text-xs text-gray-400">{entry.note ?? '—'}</td>
    </tr>
  )
})

interface SummaryCardProps {
  summary: SourceIncentiveSummary
}

const SummaryCard = memo(function SummaryCard({ summary }: SummaryCardProps): ReactElement {
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const slashed = wasSlashedThisPeriod(summary)
  const nSlashes = slashCount(summary)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-100 capitalize">{summary.sourceId}</span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700 capitalize">
              {summary.period}
            </span>
            {slashed && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-300 border border-red-500/30">
                {nSlashes} slash{nSlashes === 1 ? '' : 'es'} this period
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500">{formatDateRange(summary.periodStart, summary.periodEnd)}</span>
        </div>
        {/* Net change summary */}
        <div className="text-right">
          <div className="text-sm font-mono font-bold text-gray-100">
            Net: {summary.netChange}
          </div>
          {summary.cumulativeBalance !== null ? (
            <div className="text-xs text-gray-400 font-mono">Total: {summary.cumulativeBalance}</div>
          ) : (
            <div className="text-xs text-gray-500">Cumulative balance not reported</div>
          )}
        </div>
      </div>

      {/* Earned / slashed summary */}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-gray-500">Earned</dt>
          <dd className="font-mono text-green-400 text-sm">{summary.totalEarned}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Slashed</dt>
          <dd className={`font-mono text-sm ${slashed ? 'text-red-400' : 'text-gray-400'}`}>
            {summary.totalSlashed}
          </dd>
        </div>
      </dl>

      {/* Ledger toggle */}
      {summary.ledger.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={ledgerOpen}
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors underline-offset-2 hover:underline"
            onClick={() => setLedgerOpen((v) => !v)}
          >
            {ledgerOpen
              ? 'Hide ledger'
              : `Show ledger (${summary.ledger.length} entr${summary.ledger.length === 1 ? 'y' : 'ies'})`}
          </button>
          {ledgerOpen && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-800">
              <table className="min-w-full text-left" aria-label={`Ledger for ${summary.sourceId}`}>
                <thead>
                  <tr className="border-b border-gray-800">
                    {['#', 'Date', 'Type', 'Amount', 'Balance', 'Note'].map((h) => (
                      <th key={h} scope="col" className="py-1.5 px-3 text-xs text-gray-500 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {summary.ledger.map((entry) => (
                    <LedgerEntryRow key={entry.seq} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export interface IncentiveLedgerPanelProps {
  summaries: readonly SourceIncentiveSummary[]
}

export const IncentiveLedgerPanel = memo(function IncentiveLedgerPanel({
  summaries,
}: IncentiveLedgerPanelProps): ReactElement {
  return (
    <section aria-labelledby="incentive-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="incentive-heading" className="text-lg font-semibold text-gray-100">
          Incentive accounting
        </h2>
        <p className="text-xs text-gray-400">
          Rewards earned and slashes incurred by each source operator, based on contribution, uptime, and accuracy.
          All amounts are reported by the aggregator.
        </p>
      </div>

      {summaries.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No incentive summaries have been reported yet.</p>
      ) : (
        <ul className="flex flex-col gap-3 list-none p-0">
          {summaries.map((s, i) => (
            <li key={`${s.sourceId}-${s.period}-${i}`}>
              <SummaryCard summary={s} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
})
