import { describe, it, expect } from 'vitest'
import type { ParameterRecord } from '../types'
import {
  groupByCategory,
  latestChange,
  uniqueEditorCount,
  changedRecently,
  formatParameterValue,
  filterByOwner,
  searchParameters,
} from './parameterRegistry'

const NOW = 1_700_000_000_000

function makeRecord(overrides: Partial<ParameterRecord> = {}): ParameterRecord {
  return {
    key: 'aggregator.minSources',
    label: 'Minimum sources',
    category: 'aggregation',
    currentValue: '3',
    owner: 'GA1234567890ABCDEF',
    lastChangedAt: NOW - 1000,
    history: [
      {
        version: 1,
        changedAt: NOW - 2000,
        changedBy: 'GX_OPERATOR_A',
        previousValue: '2',
        newValue: '3',
        reason: 'Increased resilience.',
      },
    ],
    ...overrides,
  }
}

describe('groupByCategory', () => {
  it('groups records by category and sorts categories alphabetically', () => {
    const r1 = makeRecord({ key: 'z.param', category: 'staking' })
    const r2 = makeRecord({ key: 'a.param', category: 'aggregation' })
    const r3 = makeRecord({ key: 'b.param', category: 'staking' })
    const result = groupByCategory([r1, r2, r3])
    expect([...result.keys()]).toEqual(['aggregation', 'staking'])
    // Within category, sorted by key
    expect(result.get('staking')!.map((r) => r.key)).toEqual(['b.param', 'z.param'])
  })

  it('returns an empty map for an empty list', () => {
    expect(groupByCategory([])).toEqual(new Map())
  })

  it('does not mutate the input', () => {
    const records = [makeRecord({ key: 'z' }), makeRecord({ key: 'a' })]
    groupByCategory(records)
    expect(records.map((r) => r.key)).toEqual(['z', 'a'])
  })
})

describe('latestChange', () => {
  it('returns the last entry in history', () => {
    const record = makeRecord({
      history: [
        { version: 1, changedAt: NOW - 2000, changedBy: 'A', previousValue: '2', newValue: '3', reason: 'r' },
        { version: 2, changedAt: NOW - 1000, changedBy: 'B', previousValue: '3', newValue: '4', reason: 'r2' },
      ],
    })
    expect(latestChange(record)?.version).toBe(2)
  })

  it('returns null for a parameter with no history', () => {
    expect(latestChange(makeRecord({ history: [] }))).toBeNull()
  })
})

describe('uniqueEditorCount', () => {
  it('counts distinct changedBy addresses', () => {
    const record = makeRecord({
      history: [
        { version: 1, changedAt: NOW - 3000, changedBy: 'A', previousValue: '1', newValue: '2', reason: '' },
        { version: 2, changedAt: NOW - 2000, changedBy: 'B', previousValue: '2', newValue: '3', reason: '' },
        { version: 3, changedAt: NOW - 1000, changedBy: 'A', previousValue: '3', newValue: '4', reason: '' },
      ],
    })
    expect(uniqueEditorCount(record)).toBe(2)
  })

  it('returns 0 for an untouched parameter', () => {
    expect(uniqueEditorCount(makeRecord({ history: [] }))).toBe(0)
  })
})

describe('changedRecently', () => {
  it('returns true when last change is within the window', () => {
    expect(changedRecently(makeRecord({ lastChangedAt: NOW - 500 }), 1000, NOW)).toBe(true)
  })

  it('returns false when last change is outside the window', () => {
    expect(changedRecently(makeRecord({ lastChangedAt: NOW - 2000 }), 1000, NOW)).toBe(false)
  })

  it('returns false when lastChangedAt is null', () => {
    expect(changedRecently(makeRecord({ lastChangedAt: null }), 1000, NOW)).toBe(false)
  })

  it('treats an exactly-on-boundary change as within the window', () => {
    expect(changedRecently(makeRecord({ lastChangedAt: NOW - 1000 }), 1000, NOW)).toBe(true)
  })
})

describe('formatParameterValue', () => {
  it('returns the value unchanged when it fits within maxLength', () => {
    expect(formatParameterValue('abc', 10)).toBe('abc')
  })

  it('truncates and appends ellipsis for long values', () => {
    const long = 'a'.repeat(50)
    const result = formatParameterValue(long, 10)
    expect(result.length).toBe(10)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('filterByOwner', () => {
  it('returns only records matching the given address (case-insensitive)', () => {
    const r1 = makeRecord({ key: 'a', owner: 'GA_OWNER_X' })
    const r2 = makeRecord({ key: 'b', owner: 'GB_OWNER_Y' })
    const result = filterByOwner([r1, r2], 'ga_owner_x')
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe('a')
  })

  it('returns an empty list when no match', () => {
    expect(filterByOwner([makeRecord()], 'NOBODY')).toEqual([])
  })
})

describe('searchParameters', () => {
  it('matches on key substring (case-insensitive)', () => {
    const records = [
      makeRecord({ key: 'agg.minSources', label: 'Minimum sources' }),
      makeRecord({ key: 'staking.lockPeriod', label: 'Lock period' }),
    ]
    expect(searchParameters(records, 'min').map((r) => r.key)).toEqual(['agg.minSources'])
  })

  it('matches on label substring', () => {
    const records = [
      makeRecord({ key: 'a', label: 'Minimum sources' }),
      makeRecord({ key: 'b', label: 'Lock period' }),
    ]
    expect(searchParameters(records, 'lock').map((r) => r.key)).toEqual(['b'])
  })

  it('returns all records for an empty query', () => {
    const records = [makeRecord({ key: 'a' }), makeRecord({ key: 'b' })]
    expect(searchParameters(records, '   ')).toHaveLength(2)
  })

  it('returns an empty list when nothing matches', () => {
    expect(searchParameters([makeRecord()], 'zzz_no_match')).toEqual([])
  })
})
