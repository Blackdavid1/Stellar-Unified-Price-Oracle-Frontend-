import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SourceReputationScore } from '../types'
import { ReputationScorePanel } from './ReputationScorePanel'

const NOW = 1_700_000_000_000
const HALF_LIFE = 7 * 24 * 60 * 60 * 1000

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

describe('ReputationScorePanel', () => {
  it('renders the section heading', () => {
    render(<ReputationScorePanel scores={[]} now={NOW} />)
    expect(screen.getByRole('heading', { name: 'Reputation scores' })).toBeDefined()
  })

  it('shows an empty state when no scores are provided', () => {
    render(<ReputationScorePanel scores={[]} now={NOW} />)
    expect(screen.getByText(/No reputation scores have been reported yet/)).toBeDefined()
  })

  it('renders a score entry with its sourceId', () => {
    render(<ReputationScorePanel scores={[makeScore({ sourceId: 'reflector' })]} now={NOW} />)
    expect(screen.getByText('reflector')).toBeDefined()
  })

  it('shows "Score not reported" for a null score', () => {
    render(<ReputationScorePanel scores={[makeScore({ score: null })]} now={NOW} />)
    expect(screen.getByText('Score not reported')).toBeDefined()
  })

  it('shows the sybil risk label', () => {
    render(<ReputationScorePanel scores={[makeScore({ sybilRisk: 'high' })]} now={NOW} />)
    expect(screen.getByText('High risk')).toBeDefined()
  })

  it('shows attenuation when factor is below 1', () => {
    render(<ReputationScorePanel scores={[makeScore({ sybilAttenuationFactor: 0.5 })]} now={NOW} />)
    expect(screen.getByText(/Attenuated ×0\.50/)).toBeDefined()
  })

  it('shows cluster peers when sources share a cluster', () => {
    const scores = [
      makeScore({ sourceId: 'a', sybilClusterId: 'c1' }),
      makeScore({ sourceId: 'b', sybilClusterId: 'c1', score: 0.5 }),
    ]
    render(<ReputationScorePanel scores={scores} now={NOW} />)
    // Both should mention the other as a cluster peer
    const clusterTexts = screen.getAllByText(/Shares cluster with:/)
    expect(clusterTexts.length).toBeGreaterThan(0)
  })

  it('renders entries in rank order (highest effective score first)', () => {
    const scores = [
      makeScore({ sourceId: 'low', score: 0.2 }),
      makeScore({ sourceId: 'high', score: 0.9 }),
    ]
    render(<ReputationScorePanel scores={scores} now={NOW} />)
    const items = screen.getAllByRole('listitem')
    // first item should contain 'high'
    expect(items[0].textContent).toContain('high')
  })
})
