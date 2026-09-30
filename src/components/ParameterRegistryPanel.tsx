/**
 * @file ParameterRegistryPanel (#698)
 *
 * Displays all registered system parameters with their current value, owner,
 * last-changed timestamp, and full change history. Organised by category.
 *
 * Rendering rules:
 * - Never render a fabricated value. Null → explicit "not reported" text.
 * - History is shown oldest-first (as the API delivers it).
 * - Recently-changed parameters (within 24 h) get a highlight badge.
 */
import { memo, useState, type ReactElement } from 'react'
import type { ParameterRecord, ParameterChangeEntry } from '../types'
import {
  groupByCategory,
  latestChange,
  changedRecently,
  formatParameterValue,
  searchParameters,
} from '../utils/parameterRegistry'

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

interface ChangeEntryRowProps {
  entry: ParameterChangeEntry
}

const ChangeEntryRow = memo(function ChangeEntryRow({ entry }: ChangeEntryRowProps): ReactElement {
  return (
    <li className="flex flex-col gap-1 text-xs border-l-2 border-gray-700 pl-3 py-1">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-gray-500 tabular-nums">{formatTimestamp(entry.changedAt)}</span>
        <span className="font-mono text-gray-400" title={entry.changedBy}>
          {truncateAddress(entry.changedBy)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-gray-300">
        <span className="line-through text-gray-500">{formatParameterValue(entry.previousValue)}</span>
        <span aria-hidden="true">→</span>
        <span className="font-semibold">{formatParameterValue(entry.newValue)}</span>
      </div>
      {entry.reason && <p className="text-gray-400 italic">{entry.reason}</p>}
    </li>
  )
})

interface ParameterRowProps {
  record: ParameterRecord
  now: number
}

const ParameterRow = memo(function ParameterRow({ record, now }: ParameterRowProps): ReactElement {
  const [historyOpen, setHistoryOpen] = useState(false)
  const recent = changedRecently(record, RECENT_WINDOW_MS, now)
  const latest = latestChange(record)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-100 text-sm">{record.label}</span>
            {recent && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                Updated recently
              </span>
            )}
          </div>
          <span className="font-mono text-xs text-gray-500">{record.key}</span>
        </div>
        <span className="font-mono text-sm text-gray-200 bg-gray-800 px-2 py-1 rounded">
          {formatParameterValue(record.currentValue)}
        </span>
      </div>

      {/* Owner + last change */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-400">
        <div>
          <dt className="text-gray-500">Owner</dt>
          <dd className="font-mono text-gray-300" title={record.owner}>
            {truncateAddress(record.owner)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Last changed</dt>
          <dd className="text-gray-300">
            {record.lastChangedAt !== null ? formatTimestamp(record.lastChangedAt) : 'Never changed'}
          </dd>
        </div>
        {latest && (
          <div className="sm:col-span-2">
            <dt className="text-gray-500">Last reason</dt>
            <dd className="text-gray-300 italic">{latest.reason || 'No reason recorded'}</dd>
          </div>
        )}
      </dl>

      {/* Change history toggle */}
      {record.history.length > 0 && (
        <div>
          <button
            type="button"
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors underline-offset-2 hover:underline"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen
              ? 'Hide change history'
              : `Show change history (${record.history.length} change${record.history.length === 1 ? '' : 's'})`}
          </button>
          {historyOpen && (
            <ol
              aria-label={`Change history for ${record.label}`}
              className="mt-2 flex flex-col gap-2 list-none p-0"
            >
              {record.history.map((entry) => (
                <ChangeEntryRow key={entry.version} entry={entry} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
})

export interface ParameterRegistryPanelProps {
  records: readonly ParameterRecord[]
  /** Injected clock for deterministic rendering in tests. */
  now?: number
}

export const ParameterRegistryPanel = memo(function ParameterRegistryPanel({
  records,
  now = Date.now(),
}: ParameterRegistryPanelProps): ReactElement {
  const [query, setQuery] = useState('')
  const filtered = searchParameters(records, query)
  const grouped = groupByCategory(filtered)

  return (
    <section aria-labelledby="param-registry-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="param-registry-heading" className="text-lg font-semibold text-gray-100">
          Parameter registry
        </h2>
        <p className="text-xs text-gray-400">
          All registered system parameters — who owns each one, its current value, and every change that has been made.
        </p>
      </div>

      <div className="relative">
        <label htmlFor="param-search" className="sr-only">
          Search parameters
        </label>
        <input
          id="param-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by key or label…"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50"
        />
      </div>

      {grouped.size === 0 && (
        <p className="text-sm text-gray-500 text-center py-8">
          {records.length === 0 ? 'No parameters have been registered yet.' : 'No parameters match your search.'}
        </p>
      )}

      {[...grouped.entries()].map(([category, categoryRecords]) => (
        <div key={category} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-gray-400 capitalize">{category}</h3>
          <ul className="flex flex-col gap-3 list-none p-0">
            {categoryRecords.map((record) => (
              <li key={record.key}>
                <ParameterRow record={record} now={now} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
})
