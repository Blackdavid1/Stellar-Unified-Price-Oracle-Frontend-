import { describe, it, expect } from 'vitest'
import { SettlementStore, reconcile, ingestEvents, type EventSource, type SettlementRound } from './settlementStore'
import { RpcProviderPool } from '../lib/rpcFailover'

const NOW = 1_700_000_000_000
const round = (i: number, over: Partial<SettlementRound> = {}): SettlementRound => ({
  network: 'testnet', pair: 'XLM/USD', price: 0.1, ledger: 1000 + i, closedAt: NOW - i * 60_000, id: `e${i}`, ...over,
})

describe('settlement store', () => {
  it('ingests from a mocked event source through the pool, paging by cursor', async () => {
    const pages = [{ rounds: [round(0), round(1)], cursor: 'c1' }, { rounds: [round(2)], cursor: null }]
    let n = 0
    const src: EventSource = { fetchPage: async () => pages[n++] }
    const store = new SettlementStore(undefined, () => NOW)
    const pool = new RpcProviderPool(['http://rpc-a'])
    expect(await ingestEvents(pool, src, store)).toBe(3)
    expect(store.list('testnet', 'XLM/USD').map((r) => r.ledger)).toEqual([1002, 1001, 1000].sort((a, b) => b - a).reverse().reverse())
  })
  it('dedupes and isolates networks', () => {
    const s = new SettlementStore(undefined, () => NOW)
    s.ingest([round(0), round(0), round(1, { network: 'mainnet', id: 'm' })])
    expect(s.list('testnet', 'XLM/USD')).toHaveLength(1)
    expect(s.list('mainnet', 'XLM/USD')).toHaveLength(1)
  })
  it('enforces retention: max age, max rounds and hourly compaction', () => {
    const s = new SettlementStore({ rawWindowMs: 3_600_000, maxAgeMs: 10 * 3_600_000, maxRounds: 5 }, () => NOW)
    const old = Array.from({ length: 30 }, (_, i) => round(i + 100, { closedAt: NOW - 2 * 3_600_000 - i * 60_000, id: `o${i}` }))
    s.ingest([...old, round(500, { closedAt: NOW - 20 * 3_600_000, id: 'ancient' })])
    const l = s.list('testnet', 'XLM/USD')
    expect(l.find((r) => r.id === 'ancient')).toBeUndefined()
    expect(l.length).toBeLessThanOrEqual(5)
    expect(l.length).toBeLessThan(30)
  })
  it('flags divergence from the aggregate', () => {
    expect(reconcile([round(0)], 0.1).diverged).toBe(false)
    expect(reconcile([round(0)], 0.2).diverged).toBe(true)
    expect(reconcile([], 1).diverged).toBe(false)
  })
})
