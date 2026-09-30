import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SourceIncentiveSummary } from '../types'
import { IncentiveLedgerPanel } from './IncentiveLedgerPanel'

const NOW = 1_700_000_000_000

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
    ledger: [],
    ...overrides,
  }
}

describe('IncentiveLedgerPanel', () => {
  it('renders the section heading', () => {
    render(<IncentiveLedgerPanel summaries={[]} />)
    expect(screen.getByRole('heading', { name: 'Incentive accounting' })).toBeDefined()
  })

  it('shows empty state when no summaries', () => {
    render(<IncentiveLedgerPanel summaries={[]} />)
    expect(screen.getByText(/No incentive summaries have been reported yet/)).toBeDefined()
  })

  it('renders sourceId, earned, and slashed amounts', () => {
    render(<IncentiveLedgerPanel summaries={[makeSummary()]} />)
    expect(screen.getByText('chainlink')).toBeDefined()
    expect(screen.getByText('50.0')).toBeDefined()
  })

  it('shows "Cumulative balance not reported" when cumulativeBalance is null', () => {
    render(<IncentiveLedgerPanel summaries={[makeSummary({ cumulativeBalance: null })]} />)
    expect(screen.getByText('Cumulative balance not reported')).toBeDefined()
  })

  it('shows slash badge when the summary has slash events', () => {
    const summary = makeSummary({
      ledger: [
        {
          seq: 1,
          recordedAt: NOW,
          rewardType: 'slash',
          amount: '-5.0',
          runningBalance: '95.0',
          note: null,
        },
      ],
    })
    render(<IncentiveLedgerPanel summaries={[summary]} />)
    expect(screen.getByText(/1 slash this period/)).toBeDefined()
  })

  it('shows ledger toggle and expands to show entries', async () => {
    const summary = makeSummary({
      ledger: [
        {
          seq: 1,
          recordedAt: NOW,
          rewardType: 'accuracy',
          amount: '10.0',
          runningBalance: '60.0',
          note: 'Good report.',
        },
      ],
    })
    render(<IncentiveLedgerPanel summaries={[summary]} />)
    const toggle = screen.getByRole('button', { name: /Show ledger/ })
    await userEvent.click(toggle)
    expect(screen.getByText('Good report.')).toBeDefined()
  })
})
