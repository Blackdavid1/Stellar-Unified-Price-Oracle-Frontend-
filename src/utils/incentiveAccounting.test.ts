import { describe, it, expect } from 'vitest'
import type { IncentiveLedgerEntry, SourceIncentiveSummary } from '../types'
import {
  isCredit,
  filterLedger,
  latestLedgerEntry,
  slashCount,
  topEarner,
  groupByPeriod,
  wasSlashedThisPeriod,
} from './incentiveAccounting'

const NOW = 1_700_000_000_000

function makeEntry(overrides: Partial<IncentiveLedgerEntry> = {}): IncentiveLedgerEntry {
  return {
    seq: 1,
    recordedAt: NOW,
    rewardType: 'accuracy',
    amount: '10.5',
    runningBalance: '100.5',
    note: null,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<SourceIncentiveSummary> = {}): SourceIncentiveSummary {
  return {
    sourceId: 'chainlink',
    period: 'daily',
    periodStart: NOW - 86_400_000,
    periodEnd: NOW,
    totalEarned: '50.0',
    totalSlashed: '0.0',
    netChange: '50.0',
    cumulativeBalance: '150.0',
    ledger: [makeEntry()],
    ...overrides,
  }
}

describe('isCredit', () => {
  it('returns true for non-slash entries', () => {
    expect(isCredit(makeEntry({ rewardType: 'accuracy' }))).toBe(true)
    expect(isCredit(makeEntry({ rewardType: 'uptime' }))).toBe(true)
    expect(isCredit(makeEntry({ rewardType: 'staking' }))).toBe(true)
  })

  it('returns false for slash entries', () => {
    expect(isCredit(makeEntry({ rewardType: 'slash' }))).toBe(false)
  })
})

describe('filterLedger', () => {
  it('returns all entries when no type is specified', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2, rewardType: 'slash' })]
    expect(filterLedger(entries)).toHaveLength(2)
  })

  it('filters to matching reward type', () => {
    const entries = [
      makeEntry({ seq: 1, rewardType: 'accuracy' }),
      makeEntry({ seq: 2, rewardType: 'slash' }),
      makeEntry({ seq: 3, rewardType: 'accuracy' }),
    ]
    const result = filterLedger(entries, 'accuracy')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.rewardType === 'accuracy')).toBe(true)
  })

  it('returns empty array when no entries match', () => {
    expect(filterLedger([makeEntry({ rewardType: 'accuracy' })], 'slash')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2 })]
    filterLedger(entries)
    expect(entries).toHaveLength(2)
  })
})

describe('latestLedgerEntry', () => {
  it('returns the last entry (highest seq) in the ledger', () => {
    const s = makeSummary({
      ledger: [makeEntry({ seq: 1 }), makeEntry({ seq: 2 }), makeEntry({ seq: 3 })],
    })
    expect(latestLedgerEntry(s)?.seq).toBe(3)
  })

  it('returns null for an empty ledger', () => {
    expect(latestLedgerEntry(makeSummary({ ledger: [] }))).toBeNull()
  })
})

describe('slashCount', () => {
  it('counts only slash events', () => {
    const s = makeSummary({
      ledger: [
        makeEntry({ seq: 1, rewardType: 'accuracy' }),
        makeEntry({ seq: 2, rewardType: 'slash' }),
        makeEntry({ seq: 3, rewardType: 'slash' }),
      ],
    })
    expect(slashCount(s)).toBe(2)
  })

  it('returns 0 when there are no slashes', () => {
    expect(slashCount(makeSummary())).toBe(0)
  })
})

describe('topEarner', () => {
  it('returns the summary with the highest totalEarned', () => {
    const a = makeSummary({ sourceId: 'a', totalEarned: '50.0' })
    const b = makeSummary({ sourceId: 'b', totalEarned: '200.0' })
    const c = makeSummary({ sourceId: 'c', totalEarned: '10.0' })
    expect(topEarner([a, b, c])?.sourceId).toBe('b')
  })

  it('returns null for an empty array', () => {
    expect(topEarner([])).toBeNull()
  })

  it('returns the single item for a one-element array', () => {
    const s = makeSummary({ sourceId: 'only' })
    expect(topEarner([s])?.sourceId).toBe('only')
  })
})

describe('groupByPeriod', () => {
  it('groups summaries by their period field', () => {
    const a = makeSummary({ sourceId: 'a', period: 'daily' })
    const b = makeSummary({ sourceId: 'b', period: 'weekly' })
    const c = makeSummary({ sourceId: 'c', period: 'daily' })
    const result = groupByPeriod([a, b, c])
    expect(result.get('daily')?.map((s) => s.sourceId)).toEqual(['a', 'c'])
    expect(result.get('weekly')?.map((s) => s.sourceId)).toEqual(['b'])
  })

  it('returns an empty map for an empty array', () => {
    expect(groupByPeriod([])).toEqual(new Map())
  })
})

describe('wasSlashedThisPeriod', () => {
  it('returns true when the ledger contains a slash', () => {
    const s = makeSummary({ ledger: [makeEntry({ rewardType: 'slash' })] })
    expect(wasSlashedThisPeriod(s)).toBe(true)
  })

  it('returns false when there are no slashes', () => {
    expect(wasSlashedThisPeriod(makeSummary())).toBe(false)
  })
})
