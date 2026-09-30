import { describe, it, expect } from 'vitest'
import type { SourceReputationScore } from '../types'
import {
  formatReputationScore,
  projectDecayedScore,
  effectiveScore,
  decayFraction,
  rankByEffectiveScore,
  sybilClusterPeers,
} from './reputationDecay'

const HALF_LIFE = 7 * 24 * 60 * 60 * 1000 // 7 days in ms
const NOW = 1_700_000_000_000

function makeScore(overrides: Partial<SourceReputationScore> = {}): SourceReputationScore {
  return {
    sourceId: 'chainlink',
    score: 0.9,
    rawScore: 0.95,
    decayHalfLifeMs: HALF_LIFE,
    lastScoredAt: NOW - 1000,
    lastDecayAt: NOW - 500,
    sybilRisk: 'low',
    sybilAttenuationFactor: 1,
    sybilClusterId: null,
    ...overrides,
  }
}

describe('formatReputationScore', () => {
  it('formats a score as a percentage with one decimal', () => {
    expect(formatReputationScore(0.873)).toBe('87.3 %')
    expect(formatReputationScore(1)).toBe('100.0 %')
    expect(formatReputationScore(0)).toBe('0.0 %')
  })

  it('returns null for a null score — not "0 %"', () => {
    expect(formatReputationScore(null)).toBeNull()
  })
})

describe('projectDecayedScore', () => {
  it('returns the same score when no time has elapsed', () => {
    const result = projectDecayedScore(0.8, NOW, HALF_LIFE, NOW)
    expect(result).toBeCloseTo(0.8)
  })

  it('halves the score after exactly one half-life', () => {
    const result = projectDecayedScore(0.8, NOW - HALF_LIFE, HALF_LIFE, NOW)
    expect(result).toBeCloseTo(0.4, 5)
  })

  it('halves again after two half-lives', () => {
    const result = projectDecayedScore(0.8, NOW - 2 * HALF_LIFE, HALF_LIFE, NOW)
    expect(result).toBeCloseTo(0.2, 5)
  })

  it('returns null when lastScore is null', () => {
    expect(projectDecayedScore(null, NOW, HALF_LIFE, NOW)).toBeNull()
  })

  it('returns null when lastScoredAt is null', () => {
    expect(projectDecayedScore(0.8, null, HALF_LIFE, NOW)).toBeNull()
  })

  it('returns null for a zero or negative half-life', () => {
    expect(projectDecayedScore(0.8, NOW, 0, NOW)).toBeNull()
    expect(projectDecayedScore(0.8, NOW, -1000, NOW)).toBeNull()
  })

  it('clamps elapsed to zero when now is before lastScoredAt (clock skew)', () => {
    // Should not produce a score higher than the original
    const result = projectDecayedScore(0.8, NOW + HALF_LIFE, HALF_LIFE, NOW)
    expect(result).toBeCloseTo(0.8, 5)
  })
})

describe('effectiveScore', () => {
  it('multiplies score by sybilAttenuationFactor', () => {
    expect(effectiveScore(makeScore({ score: 0.8, sybilAttenuationFactor: 0.5 }))).toBeCloseTo(0.4)
  })

  it('returns null when score is null', () => {
    expect(effectiveScore(makeScore({ score: null }))).toBeNull()
  })

  it('returns score unchanged when attenuation is 1', () => {
    expect(effectiveScore(makeScore({ score: 0.7, sybilAttenuationFactor: 1 }))).toBeCloseTo(0.7)
  })
})

describe('decayFraction', () => {
  it('returns 0 when no time has elapsed', () => {
    expect(decayFraction(NOW, HALF_LIFE, NOW)).toBeCloseTo(0)
  })

  it('returns 1 after one full half-life', () => {
    expect(decayFraction(NOW - HALF_LIFE, HALF_LIFE, NOW)).toBeCloseTo(1)
  })

  it('clamps to 1 past the half-life', () => {
    expect(decayFraction(NOW - 2 * HALF_LIFE, HALF_LIFE, NOW)).toBe(1)
  })

  it('returns null when lastScoredAt is null', () => {
    expect(decayFraction(null, HALF_LIFE, NOW)).toBeNull()
  })

  it('returns null for a non-positive half-life', () => {
    expect(decayFraction(NOW, 0, NOW)).toBeNull()
  })
})

describe('rankByEffectiveScore', () => {
  it('places higher effective scores first', () => {
    const a = makeScore({ sourceId: 'a', score: 0.5, sybilAttenuationFactor: 1 })
    const b = makeScore({ sourceId: 'b', score: 0.9, sybilAttenuationFactor: 1 })
    expect(rankByEffectiveScore([a, b]).map((s) => s.sourceId)).toEqual(['b', 'a'])
  })

  it('places null scores last', () => {
    const a = makeScore({ sourceId: 'a', score: null })
    const b = makeScore({ sourceId: 'b', score: 0.1 })
    expect(rankByEffectiveScore([a, b]).map((s) => s.sourceId)).toEqual(['b', 'a'])
  })

  it('breaks ties by sybilRisk (low risk preferred)', () => {
    const a = makeScore({ sourceId: 'a', score: 0.5, sybilAttenuationFactor: 1, sybilRisk: 'high' })
    const b = makeScore({ sourceId: 'b', score: 0.5, sybilAttenuationFactor: 1, sybilRisk: 'low' })
    expect(rankByEffectiveScore([a, b]).map((s) => s.sourceId)).toEqual(['b', 'a'])
  })

  it('breaks identical-rank ties by sourceId lexicographically', () => {
    const a = makeScore({ sourceId: 'z', score: 0.5, sybilAttenuationFactor: 1, sybilRisk: 'low' })
    const b = makeScore({ sourceId: 'a', score: 0.5, sybilAttenuationFactor: 1, sybilRisk: 'low' })
    expect(rankByEffectiveScore([a, b]).map((s) => s.sourceId)).toEqual(['a', 'z'])
  })

  it('does not mutate the input', () => {
    const arr = [makeScore({ sourceId: 'z' }), makeScore({ sourceId: 'a' })]
    rankByEffectiveScore(arr)
    expect(arr.map((s) => s.sourceId)).toEqual(['z', 'a'])
  })
})

describe('sybilClusterPeers', () => {
  it('returns sources in the same cluster, excluding the query source', () => {
    const a = makeScore({ sourceId: 'a', sybilClusterId: 'cluster-1' })
    const b = makeScore({ sourceId: 'b', sybilClusterId: 'cluster-1' })
    const c = makeScore({ sourceId: 'c', sybilClusterId: 'cluster-2' })
    const result = sybilClusterPeers([a, b, c], 'a')
    expect(result.map((s) => s.sourceId)).toEqual(['b'])
  })

  it('returns empty when the source has no cluster', () => {
    const a = makeScore({ sourceId: 'a', sybilClusterId: null })
    const b = makeScore({ sourceId: 'b', sybilClusterId: 'cluster-1' })
    expect(sybilClusterPeers([a, b], 'a')).toEqual([])
  })

  it('returns empty when the source is not found', () => {
    expect(sybilClusterPeers([makeScore({ sourceId: 'a' })], 'unknown')).toEqual([])
  })
})
