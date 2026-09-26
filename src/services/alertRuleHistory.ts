/**
 * @file Append-only alert rule version history (#645).
 *
 * Every edit to a rule appends a version {snapshot, diff vs previous, timestamp}
 * instead of overwriting. Snapshots contain only the rule DEFINITION - runtime
 * bookkeeping (fire counts, snooze, escalation/retest state, baselines) is excluded
 * so reverting reproduces the previous trigger behaviour without rewinding state.
 * Because the snapshot is generic over the definition keys, optional fields added by
 * other features (e.g. schedule triggers, #646) are versioned automatically.
 *
 * Retention (documented): at most `MAX_VERSIONS_PER_RULE` (50) versions per rule. When
 * exceeded, the oldest versions are compacted: the oldest kept entry becomes the
 * baseline (its diff is dropped) so the chain stays self-consistent. Storage is
 * localStorage (no backend); each version is re-validated on read and dropped if
 * malformed.
 */
import type { Alert } from '../types'

export const RULE_HISTORY_STORAGE_KEY = 'spo.alertRuleHistory.v1'
export const MAX_VERSIONS_PER_RULE = 50

/** Runtime/bookkeeping keys that are not part of a rule's definition. */
export const RUNTIME_KEYS = [
  'id',
  'createdAt',
  'lastTriggeredAt',
  'fireCount',
  'snoozedUntil',
  'escalationState',
  'retestState',
  'percentageBaselinePrice',
  'percentageBaselineTimestamp',
] as const

export type RuleSnapshot = Record<string, unknown>

export interface RuleDiffEntry {
  key: string
  before: unknown
  after: unknown
}

export interface RuleVersion {
  version: number
  at: number
  snapshot: RuleSnapshot
  /** Changes relative to the previous version; empty for the baseline. */
  diff: RuleDiffEntry[]
  /** Set when this version was created by reverting to `revertedFrom`. */
  revertedFrom?: number
}

export type RuleHistoryMap = Record<string, RuleVersion[]>

export function snapshotRule(alert: Alert): RuleSnapshot {
  const out: RuleSnapshot = {}
  for (const [k, v] of Object.entries(alert)) {
    if ((RUNTIME_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  return out
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
    : val,
) ?? 'undefined'

export function diffSnapshots(before: RuleSnapshot, after: RuleSnapshot): RuleDiffEntry[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys
    .filter((k) => stable(before[k]) !== stable(after[k]))
    .map((key) => ({ key, before: before[key], after: after[key] }))
}

function isValidVersion(v: unknown): v is RuleVersion {
  if (!v || typeof v !== 'object') return false
  const x = v as RuleVersion
  return (
    Number.isInteger(x.version) &&
    typeof x.at === 'number' &&
    !!x.snapshot && typeof x.snapshot === 'object' &&
    typeof x.snapshot.assetPair === 'string' &&
    Array.isArray(x.diff)
  )
}

export function loadRuleHistory(): RuleHistoryMap {
  try {
    const raw = localStorage.getItem(RULE_HISTORY_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') return {}
    const out: RuleHistoryMap = {}
    for (const [id, versions] of Object.entries(parsed)) {
      if (Array.isArray(versions)) out[id] = versions.filter(isValidVersion)
    }
    return out
  } catch {
    return {}
  }
}

function save(map: RuleHistoryMap): void {
  try {
    localStorage.setItem(RULE_HISTORY_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota/private mode: history is best-effort */
  }
}

export function getRuleVersions(alertId: string): RuleVersion[] {
  return loadRuleHistory()[alertId] ?? []
}

/** Pure append. Returns the same array when the snapshot is unchanged (idempotent). */
export function appendVersion(
  versions: readonly RuleVersion[],
  snapshot: RuleSnapshot,
  at: number,
  revertedFrom?: number,
  max = MAX_VERSIONS_PER_RULE,
): RuleVersion[] {
  const last = versions[versions.length - 1]
  if (last && diffSnapshots(last.snapshot, snapshot).length === 0) return [...versions]
  const next: RuleVersion = {
    version: (last?.version ?? 0) + 1,
    at,
    snapshot,
    diff: last ? diffSnapshots(last.snapshot, snapshot) : [],
    ...(revertedFrom !== undefined ? { revertedFrom } : {}),
  }
  const all = [...versions, next]
  if (all.length <= max) return all
  const kept = all.slice(all.length - max)
  kept[0] = { ...kept[0], diff: [] } // compaction: oldest kept becomes the baseline
  return kept
}

/** Records the current definition of `alert` (call on create and on every edit). */
export function recordRuleVersion(alert: Alert, at: number = Date.now(), revertedFrom?: number): void {
  const map = loadRuleHistory()
  const next = appendVersion(map[alert.id] ?? [], snapshotRule(alert), at, revertedFrom)
  map[alert.id] = next
  save(map)
}

export function removeRuleHistory(alertId: string): void {
  const map = loadRuleHistory()
  delete map[alertId]
  save(map)
}

/**
 * Applies a stored version's definition onto the live alert, keeping runtime state.
 * The caller persists the result and should then call `recordRuleVersion(result, at, version)`.
 */
export function revertRule(alert: Alert, version: RuleVersion): Alert {
  return { ...alert, ...(version.snapshot as Partial<Alert>) }
}
