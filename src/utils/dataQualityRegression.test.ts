import { describe, expect, it } from 'vitest'
import { detectQualityRegression, type QualitySnapshot } from './dataQualityRegression'

// Deterministic seeded PRNG (mulberry32) for jitter.
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function series(n: number, seed: number, level: (i: number) => number, sources: (i: number) => string[]): QualitySnapshot[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const score = level(i) + (r() - 0.5) * 2
    return {
      t: i * 1000,
      score,
      factors: { freshness: score, confidence: score, deviation: 90, sourceCoverage: level(i) > 80 ? 90 : 40 },
      sources: sources(i),
    }
  })
}

describe('detectQualityRegression', () => {
  it('returns null with too little baseline', () => {
    expect(detectQualityRegression('BTC/USD', series(8, 1, () => 90, () => ['a']))).toBeNull()
  })

  it('does not flag a stable pair', () => {
    const r = detectQualityRegression('BTC/USD', series(30, 7, () => 90, () => ['a', 'b']))
    expect(r?.flagged).toBe(false)
  })

  it('flags a degradation and links contributing sources', () => {
    const h = series(30, 7, (i) => (i < 25 ? 90 : 60), (i) => (i < 25 ? ['a', 'b'] : ['a']))
    const r = detectQualityRegression('BTC/USD', h)!
    expect(r.flagged).toBe(true)
    expect(r.drop).toBeGreaterThan(25)
    expect(r.worstFactors[0].factor).toBe('sourceCoverage')
    expect(r.sources).toEqual([
      { source: 'a', missingRecently: false },
      { source: 'b', missingRecently: true },
    ])
  })

  it('is deterministic and order-independent', () => {
    const h = series(30, 3, (i) => (i < 25 ? 90 : 70), () => ['a'])
    expect(detectQualityRegression('X', [...h].reverse())).toEqual(detectQualityRegression('X', h))
  })
})
