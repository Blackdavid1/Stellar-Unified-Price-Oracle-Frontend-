/**
 * @file Pure helpers for the parameter registry (#698).
 *
 * Tunables (thresholds, weights, timeouts, budgets) are surfaced here so any
 * participant can list every registered parameter, see who owns it, and read
 * the complete change log.
 *
 * Rules (inherited from the governance trust posture):
 * 1. Never fabricate a value. Missing API data → null, not a default.
 * 2. Never reinterpret ownership or history. What the API said is what we show.
 */
import type { ParameterRecord, ParameterChangeEntry } from '../types'

/**
 * Groups a flat list of parameter records by their `category` field.
 * Categories are sorted alphabetically; records within each category are
 * sorted by `key`.
 */
export function groupByCategory(records: readonly ParameterRecord[]): Map<string, ParameterRecord[]> {
  const map = new Map<string, ParameterRecord[]>()
  for (const record of records) {
    const existing = map.get(record.category)
    if (existing) {
      existing.push(record)
    } else {
      map.set(record.category, [record])
    }
  }
  // Sort keys alphabetically, then records within each group by key
  const sorted = new Map<string, ParameterRecord[]>(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, recs]) => [cat, [...recs].sort((a, b) => a.key.localeCompare(b.key))]),
  )
  return sorted
}

/**
 * Returns the most recent `ParameterChangeEntry` for a record, or `null` when
 * the history is empty. Does **not** sort — the API guarantees oldest-first
 * order; we take the last element.
 */
export function latestChange(record: ParameterRecord): ParameterChangeEntry | null {
  if (record.history.length === 0) return null
  return record.history[record.history.length - 1]
}

/**
 * Counts the number of distinct operators (`changedBy`) in a record's history.
 * Returns 0 for a parameter that has never been changed.
 */
export function uniqueEditorCount(record: ParameterRecord): number {
  return new Set(record.history.map((e) => e.changedBy)).size
}

/**
 * Returns true when the parameter was changed within the last `windowMs`
 * milliseconds. Useful for flagging recently-touched parameters in the UI.
 */
export function changedRecently(record: ParameterRecord, windowMs: number, now: number = Date.now()): boolean {
  if (record.lastChangedAt === null) return false
  return now - record.lastChangedAt <= windowMs
}

/**
 * Formats a parameter value for display. Currently a thin wrapper that keeps
 * the formatting logic in one place — callers should not rely on raw strings
 * being safe to truncate at an arbitrary column.
 */
export function formatParameterValue(value: string, maxLength: number = 40): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

/**
 * Finds parameters whose owner matches a given Stellar address (case-insensitive).
 */
export function filterByOwner(records: readonly ParameterRecord[], ownerAddress: string): ParameterRecord[] {
  const lower = ownerAddress.toLowerCase()
  return records.filter((r) => r.owner.toLowerCase() === lower)
}

/**
 * Searches parameter records by label or key prefix/substring (case-insensitive).
 * Returns matching records in the original order.
 */
export function searchParameters(records: readonly ParameterRecord[], query: string): ParameterRecord[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...records]
  return records.filter((r) => r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q))
}
