import { describe, it, expect, beforeEach } from 'vitest'
import { RpcProviderPool, RpcOutageError, parseProviderList } from './rpcFailover'
import { circuitBreaker } from '../api/circuitBreaker'

const fast = { sleep: async () => {}, retriesPerProvider: 0, timeoutMs: 50 }

describe('RpcProviderPool', () => {
  beforeEach(() => circuitBreaker.reset())

  it('parses provider lists', () => {
    expect(parseProviderList(' a, b ,,c')).toEqual(['a', 'b', 'c'])
  })

  it('fails over on error and rate-limit', async () => {
    const pool = new RpcProviderPool(['a', 'b', 'c'], fast)
    const r = await pool.call(async (u) => {
      if (u === 'a') throw Object.assign(new Error('429'), { status: 429 })
      if (u === 'b') throw new Error('boom')
      return 'ok'
    })
    expect(r).toEqual({ value: 'ok', url: 'c' })
    expect(pool.health()[0].failures).toBe(1)
  })

  it('fails over on timeout', async () => {
    const pool = new RpcProviderPool(['a', 'b'], fast)
    const r = await pool.call((u) => (u === 'a' ? new Promise<string>(() => {}) : Promise.resolve('b-ok')))
    expect(r.url).toBe('b')
  })

  it('health scores drive selection and preferred recovers', async () => {
    const pool = new RpcProviderPool(['a', 'b'], { ...fast, ewmaAlpha: 0.5 })
    for (let i = 0; i < 3; i++) await pool.call(async (u) => { if (u === 'a') throw new Error('x'); return 1 })
    expect(pool.health()[0].score).toBeLessThan(pool.health()[1].score)
    expect(pool.candidates()[0]).toBe('b')
    circuitBreaker.reset()
    for (let i = 0; i < 6; i++) await pool.call(async (u) => { if (u === 'b') throw new Error('x'); return 1 }).catch(() => {})
    // a keeps succeeding when b is being failed; a's score recovers to preferred
    expect(pool.candidates()[0]).toBe('a')
  })

  it('opens the circuit and reports total outage', async () => {
    const pool = new RpcProviderPool(['a', 'b'], fast)
    for (let i = 0; i < 10; i++) await pool.call(async () => { throw new Error('down') }).catch(() => {})
    expect(pool.health().every((h) => h.circuit === 'open')).toBe(true)
    await expect(pool.call(async () => 1)).rejects.toBeInstanceOf(RpcOutageError)
  })

  it('excludes stale tips from candidates', () => {
    const pool = new RpcProviderPool(['a', 'b'], { ...fast, maxLedgerLag: 2 })
    pool.recordLedger('a', 100)
    pool.recordLedger('b', 90)
    expect(pool.isStale('b')).toBe(true)
    expect(pool.candidates()[0]).toBe('a')
  })
})
