import { describe, it, expect } from 'vitest'
import type { PriceDispute } from '../types'
import {
  isDisputeResolved,
  isDeadlineBreached,
  orderDisputes,
  filterByAssetPair,
  filterByImplicatedSource,
  openDisputeCount,
  evidenceCountLabel,
} from './disputeProcess'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

function makeDispute(overrides: Partial<PriceDispute> = {}): PriceDispute {
  return {
    id: 'DSP-1',
    assetPair: 'XLM/USD',
    contestedAt: NOW - DAY,
    contestedPrice: '0.1234',
    challengerPrice: '0.1300',
    challenger: 'GA_CHALLENGER',
    status: 'open',
    openedAt: NOW - DAY,
    resolutionDeadline: NOW + DAY,
    rationale: 'Source outlier detected.',
    impliedSources: ['reflector'],
    evidence: [],
    comments: [],
    resolutionNote: null,
    ...overrides,
  }
}

describe('isDisputeResolved', () => {
  it('returns false for open disputes', () => {
    expect(isDisputeResolved(makeDispute({ status: 'open' }))).toBe(false)
  })

  it('returns false for disputes under review', () => {
    expect(isDisputeResolved(makeDispute({ status: 'under_review' }))).toBe(false)
  })

  it('returns true for resolved_upheld', () => {
    expect(isDisputeResolved(makeDispute({ status: 'resolved_upheld' }))).toBe(true)
  })

  it('returns true for resolved_overturned', () => {
    expect(isDisputeResolved(makeDispute({ status: 'resolved_overturned' }))).toBe(true)
  })

  it('returns true for withdrawn', () => {
    expect(isDisputeResolved(makeDispute({ status: 'withdrawn' }))).toBe(true)
  })
})

describe('isDeadlineBreached', () => {
  it('returns true when deadline has passed for an open dispute', () => {
    expect(isDeadlineBreached(makeDispute({ status: 'open', resolutionDeadline: NOW - 1 }), NOW)).toBe(true)
  })

  it('returns false when deadline has not passed', () => {
    expect(isDeadlineBreached(makeDispute({ status: 'open', resolutionDeadline: NOW + 1 }), NOW)).toBe(false)
  })

  it('returns false when resolutionDeadline is null', () => {
    expect(isDeadlineBreached(makeDispute({ resolutionDeadline: null }), NOW)).toBe(false)
  })

  it('returns false for an already resolved dispute even if past deadline', () => {
    expect(
      isDeadlineBreached(makeDispute({ status: 'resolved_upheld', resolutionDeadline: NOW - 1 }), NOW),
    ).toBe(false)
  })
})

describe('orderDisputes', () => {
  it('places open before under_review before resolved', () => {
    const resolved = makeDispute({ id: 'r', status: 'resolved_upheld' })
    const open = makeDispute({ id: 'o', status: 'open' })
    const reviewing = makeDispute({ id: 'u', status: 'under_review' })
    expect(orderDisputes([resolved, reviewing, open]).map((d) => d.id)).toEqual(['o', 'u', 'r'])
  })

  it('among active disputes, orders by soonest deadline first', () => {
    const soon = makeDispute({ id: 'a', status: 'open', resolutionDeadline: NOW + DAY })
    const later = makeDispute({ id: 'b', status: 'open', resolutionDeadline: NOW + 2 * DAY })
    const noDeadline = makeDispute({ id: 'c', status: 'open', resolutionDeadline: null })
    expect(orderDisputes([noDeadline, later, soon]).map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('among resolved disputes, orders by most recently opened first', () => {
    const older = makeDispute({ id: 'old', status: 'resolved_upheld', openedAt: NOW - 2 * DAY })
    const newer = makeDispute({ id: 'new', status: 'resolved_upheld', openedAt: NOW - DAY })
    expect(orderDisputes([older, newer]).map((d) => d.id)).toEqual(['new', 'old'])
  })

  it('breaks ties by id for determinism', () => {
    const a = makeDispute({ id: 'z', status: 'open', resolutionDeadline: NOW + DAY })
    const b = makeDispute({ id: 'a', status: 'open', resolutionDeadline: NOW + DAY })
    expect(orderDisputes([a, b]).map((d) => d.id)).toEqual(['a', 'z'])
  })

  it('does not mutate the input', () => {
    const arr = [makeDispute({ id: 'z' }), makeDispute({ id: 'a' })]
    orderDisputes(arr)
    expect(arr.map((d) => d.id)).toEqual(['z', 'a'])
  })
})

describe('filterByAssetPair', () => {
  it('returns only disputes for the given pair (case-insensitive)', () => {
    const a = makeDispute({ id: 'a', assetPair: 'XLM/USD' })
    const b = makeDispute({ id: 'b', assetPair: 'BTC/USD' })
    expect(filterByAssetPair([a, b], 'xlm/usd').map((d) => d.id)).toEqual(['a'])
  })

  it('returns empty when no disputes match', () => {
    expect(filterByAssetPair([makeDispute()], 'ETH/USD')).toEqual([])
  })
})

describe('filterByImplicatedSource', () => {
  it('returns disputes that implicate the given source (case-insensitive)', () => {
    const a = makeDispute({ id: 'a', impliedSources: ['reflector', 'band'] })
    const b = makeDispute({ id: 'b', impliedSources: ['chainlink'] })
    expect(filterByImplicatedSource([a, b], 'REFLECTOR').map((d) => d.id)).toEqual(['a'])
  })

  it('returns empty when no disputes implicate the source', () => {
    expect(filterByImplicatedSource([makeDispute()], 'chainlink')).toEqual([])
  })
})

describe('openDisputeCount', () => {
  it('counts open and under_review disputes', () => {
    const disputes = [
      makeDispute({ status: 'open' }),
      makeDispute({ status: 'under_review' }),
      makeDispute({ status: 'resolved_upheld' }),
      makeDispute({ status: 'withdrawn' }),
    ]
    expect(openDisputeCount(disputes)).toBe(2)
  })

  it('returns 0 when all disputes are resolved', () => {
    expect(openDisputeCount([makeDispute({ status: 'resolved_upheld' })])).toBe(0)
  })
})

describe('evidenceCountLabel', () => {
  it('uses singular for one piece of evidence', () => {
    const d = makeDispute({
      evidence: [
        {
          id: 'e1',
          submittedBy: 'G_ADDR',
          submittedAt: NOW,
          description: 'tx proof',
          uri: 'ipfs://abc',
        },
      ],
    })
    expect(evidenceCountLabel(d)).toBe('1 piece of evidence')
  })

  it('uses plural for zero or many', () => {
    expect(evidenceCountLabel(makeDispute({ evidence: [] }))).toBe('0 pieces of evidence')
    expect(
      evidenceCountLabel(
        makeDispute({
          evidence: [
            { id: 'e1', submittedBy: 'G', submittedAt: NOW, description: 'd', uri: null },
            { id: 'e2', submittedBy: 'G', submittedAt: NOW, description: 'd', uri: null },
            { id: 'e3', submittedBy: 'G', submittedAt: NOW, description: 'd', uri: null },
          ],
        }),
      ),
    ).toBe('3 pieces of evidence')
  })
})
