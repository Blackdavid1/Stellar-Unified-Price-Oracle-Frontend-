import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ParameterRecord } from '../types'
import { ParameterRegistryPanel } from './ParameterRegistryPanel'

const NOW = 1_700_000_000_000

function makeRecord(overrides: Partial<ParameterRecord> = {}): ParameterRecord {
  return {
    key: 'aggregator.minSources',
    label: 'Minimum sources',
    category: 'aggregation',
    currentValue: '3',
    owner: 'GA1234567890ABCDEF',
    lastChangedAt: NOW - 1000,
    history: [],
    ...overrides,
  }
}

describe('ParameterRegistryPanel', () => {
  it('renders the section heading', () => {
    render(<ParameterRegistryPanel records={[]} now={NOW} />)
    expect(screen.getByRole('heading', { name: 'Parameter registry' })).toBeDefined()
  })

  it('shows a message when there are no records', () => {
    render(<ParameterRegistryPanel records={[]} now={NOW} />)
    expect(screen.getByText(/No parameters have been registered yet/)).toBeDefined()
  })

  it('renders a record with its label, key, and current value', () => {
    render(<ParameterRegistryPanel records={[makeRecord()]} now={NOW} />)
    expect(screen.getByText('Minimum sources')).toBeDefined()
    expect(screen.getByText('aggregator.minSources')).toBeDefined()
    expect(screen.getByText('3')).toBeDefined()
  })

  it('groups records by category with a category heading', () => {
    const records = [
      makeRecord({ key: 'agg.min', category: 'aggregation', label: 'Min sources' }),
      makeRecord({ key: 'stake.period', category: 'staking', label: 'Lock period' }),
    ]
    render(<ParameterRegistryPanel records={records} now={NOW} />)
    expect(screen.getByText('aggregation')).toBeDefined()
    expect(screen.getByText('staking')).toBeDefined()
  })

  it('shows recently-updated badge for changes within 24 h', () => {
    const record = makeRecord({ lastChangedAt: NOW - 1000 }) // 1 second ago
    render(<ParameterRegistryPanel records={[record]} now={NOW} />)
    expect(screen.getByText('Updated recently')).toBeDefined()
  })

  it('does not show recently-updated badge for older changes', () => {
    const record = makeRecord({ lastChangedAt: NOW - 2 * 24 * 60 * 60 * 1000 }) // 2 days ago
    render(<ParameterRegistryPanel records={[record]} now={NOW} />)
    expect(screen.queryByText('Updated recently')).toBeNull()
  })

  it('shows "Never changed" when lastChangedAt is null', () => {
    render(<ParameterRegistryPanel records={[makeRecord({ lastChangedAt: null })]} now={NOW} />)
    expect(screen.getByText('Never changed')).toBeDefined()
  })

  it('shows a history toggle when the record has history entries', async () => {
    const user = userEvent.setup()
    const record = makeRecord({
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
    })
    render(<ParameterRegistryPanel records={[record]} now={NOW} />)
    const toggle = screen.getByRole('button', { name: /Show change history/ })
    expect(toggle).toBeDefined()
    await user.click(toggle)
    // Reason appears in both the "Last reason" summary and the expanded history
    const reasonTexts = screen.getAllByText('Increased resilience.')
    expect(reasonTexts.length).toBeGreaterThanOrEqual(1)
  })

  it('filters records by search query', async () => {
    const user = userEvent.setup()
    const records = [
      makeRecord({ key: 'agg.min', label: 'Minimum sources', category: 'aggregation' }),
      makeRecord({ key: 'stake.lock', label: 'Lock period', category: 'staking' }),
    ]
    render(<ParameterRegistryPanel records={records} now={NOW} />)
    const input = screen.getByRole('searchbox')
    await user.type(input, 'lock')
    expect(screen.queryByText('Minimum sources')).toBeNull()
    expect(screen.getByText('Lock period')).toBeDefined()
  })

  it('shows "no match" message when search yields nothing', async () => {
    const user = userEvent.setup()
    render(<ParameterRegistryPanel records={[makeRecord()]} now={NOW} />)
    await user.type(screen.getByRole('searchbox'), 'zzz_nomatch')
    expect(screen.getByText(/No parameters match your search/)).toBeDefined()
  })
})
