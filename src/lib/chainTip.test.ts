import { describe, it, expect, beforeEach } from 'vitest'
import { AnchorStore, pinnedRead } from './chainTip'
import { RpcProviderPool } from './rpcFailover'
import { circuitBreaker } from '../api/circuitBreaker'

const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('chain tip consistency', () => {
  beforeEach(() => circuitBreaker.reset())

  it('pins and records the ledger sequence', async () => {
    const pool = new RpcProviderPool(['a'], { sleep: async () => {} })
    const store = new AnchorStore(mem())
    const r = await pinnedRead(pool, store, 'XLM', async () => ({ value: 1, ledger: 100, ledgerHash: 'h1' }))
    expect(r.anchor).toMatchObject({ sequence: 100, status: 'anchored' })
    expect(store.get('XLM')?.sequence).toBe(100)
  })

  it('flips affected records to reorged on hash change', () => {
    const store = new AnchorStore(mem())
    store.observe('XLM', 100, 'h1')
    store.observe('USDC', 100, 'h1')
    const a = store.observe('BTC', 100, 'h2')
    expect(a.status).toBe('reorged')
    expect(store.get('XLM')?.status).toBe('reorged')
    expect(store.get('USDC')?.status).toBe('reorged')
  })

  it('excludes a lagging RPC from latest and fails over', async () => {
    const pool = new RpcProviderPool(['lag', 'good'], { sleep: async () => {}, retriesPerProvider: 0, maxLedgerLag: 2 })
    pool.recordLedger('good', 200)
    const store = new AnchorStore(mem())
    const seen: string[] = []
    const r = await pinnedRead(pool, store, 'XLM', async (u) => {
      seen.push(u)
      return { value: 1, ledger: u === 'lag' ? 150 : 200 }
    })
    expect(r.provider).toBe('good')
    expect(r.anchor.sequence).toBe(200)
  })

  it('rejects a stale tip result even when it was the only candidate seen first', async () => {
    const pool = new RpcProviderPool(['lag', 'good'], { sleep: async () => {}, retriesPerProvider: 0, maxLedgerLag: 2 })
    pool.recordLedger('good', 200)
    pool.recordLedger('lag', 150)
    expect(pool.candidates()[0]).toBe('good')
  })
})
