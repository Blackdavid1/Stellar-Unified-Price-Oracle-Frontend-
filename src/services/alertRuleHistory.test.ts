import { beforeEach, describe, expect, it } from 'vitest'
import type { Alert } from '../types'
import {
  MAX_VERSIONS_PER_RULE,
  appendVersion,
  getRuleVersions,
  recordRuleVersion,
  revertRule,
  snapshotRule,
  RULE_HISTORY_STORAGE_KEY,
} from './alertRuleHistory'

const base = { id: 'a1', assetPair: 'BTC/USD', upperThreshold: 100, lowerThreshold: null, fireCount: 0, createdAt: 1, active: true } as unknown as Alert

describe('alertRuleHistory', () => {
  beforeEach(() => localStorage.clear())

  it('excludes runtime state from snapshots', () => {
    const s = snapshotRule({ ...base, fireCount: 9 })
    expect(s).not.toHaveProperty('fireCount')
    expect(s).toHaveProperty('upperThreshold', 100)
  })

  it('appends versions with diffs and is idempotent for no-op edits', () => {
    recordRuleVersion(base, 1)
    recordRuleVersion({ ...base, fireCount: 3 }, 2) // runtime-only: no new version
    recordRuleVersion({ ...base, upperThreshold: 150 }, 3)
    const v = getRuleVersions('a1')
    expect(v.map((x) => x.version)).toEqual([1, 2])
    expect(v[1].diff).toEqual([{ key: 'upperThreshold', before: 100, after: 150 }])
  })

  it('revert reproduces the previous definition and keeps runtime state', () => {
    recordRuleVersion(base, 1)
    const edited = { ...base, upperThreshold: 150, fireCount: 4 }
    recordRuleVersion(edited, 2)
    const reverted = revertRule(edited, getRuleVersions('a1')[0])
    expect(reverted.upperThreshold).toBe(100)
    expect(reverted.fireCount).toBe(4)
    recordRuleVersion(reverted, 3, 1)
    const v = getRuleVersions('a1')
    expect(v[2].revertedFrom).toBe(1)
    expect(snapshotRule(reverted)).toEqual(v[0].snapshot)
  })

  it('bounds history and compacts the oldest to a baseline', () => {
    let v = appendVersion([], { assetPair: 'X', n: 0 }, 0)
    for (let i = 1; i < MAX_VERSIONS_PER_RULE + 5; i++) v = appendVersion(v, { assetPair: 'X', n: i }, i)
    expect(v).toHaveLength(MAX_VERSIONS_PER_RULE)
    expect(v[0].diff).toEqual([])
    expect(v[v.length - 1].version).toBe(MAX_VERSIONS_PER_RULE + 5)
  })

  it('drops malformed versions on read', () => {
    localStorage.setItem(RULE_HISTORY_STORAGE_KEY, JSON.stringify({ a1: [{ nope: true }] }))
    expect(getRuleVersions('a1')).toEqual([])
  })
})
