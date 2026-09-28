import { describe, it, expect, vi } from 'vitest'
import { checkNetwork, assertWalletOnAppNetwork, stampProofNetwork } from './networkGuard'
import { NETWORK_PASSPHRASES } from '../lib/networkRegistry'
import type { OracleNetwork } from '../lib/contractRegistry'

vi.mock('./freighterClient', () => ({
  WalletError: class extends Error { code: string; constructor(c: string, m: string) { super(m); this.code = c } },
  getFreighterNetwork: vi.fn(),
}))
import { getFreighterNetwork } from './freighterClient'

const nets: OracleNetwork[] = ['mainnet', 'testnet', 'futurenet']

describe('checkNetwork', () => {
  for (const e of nets) for (const a of nets) {
    it(`${e} app vs ${a} wallet`, () => {
      const r = checkNetwork(e, NETWORK_PASSPHRASES[a])
      expect(r.ok).toBe(e === a)
      if (e !== a) expect(r.message).toContain(e)
    })
  }
  it('rejects unknown passphrases', () => {
    const r = checkNetwork('testnet', 'Standalone Network ; February 2017')
    expect(r.ok).toBe(false)
    expect(r.actual).toBeNull()
    expect(r.message).toContain('unknown')
  })
})

describe('assertWalletOnAppNetwork', () => {
  it('throws wrong-network on mismatch and returns passphrase on match', async () => {
    vi.mocked(getFreighterNetwork).mockResolvedValue({ network: 'PUBLIC', networkPassphrase: NETWORK_PASSPHRASES.mainnet })
    await expect(assertWalletOnAppNetwork('testnet')).rejects.toMatchObject({ code: 'wrong-network' })
    await expect(assertWalletOnAppNetwork('mainnet')).resolves.toBe(NETWORK_PASSPHRASES.mainnet)
  })
})

describe('stampProofNetwork', () => {
  it('adds the passphrase', () => {
    const p = stampProofNetwork({ network: 'mainnet' } as never) as { networkPassphrase: string }
    expect(p.networkPassphrase).toBe(NETWORK_PASSPHRASES.mainnet)
  })
})
