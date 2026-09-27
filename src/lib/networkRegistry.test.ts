import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildRegistry, getNetworkConfig, NetworkConfigSchema, NetworkScopedCache, networkCacheKey,
  setSelectedNetwork, getSelectedNetwork, clearSelectedNetwork, networkFromPassphrase, NETWORK_PASSPHRASES,
} from './networkRegistry'

beforeEach(() => { localStorage.clear(); clearSelectedNetwork() })

describe('networkRegistry', () => {
  it('builds a valid registry for every network', () => {
    const r = buildRegistry()
    expect(r.testnet.passphrase).toBe(NETWORK_PASSPHRASES.testnet)
    expect(Object.keys(getNetworkConfig('mainnet').assets)).toContain('XLM')
  })
  it('fails fast on a bad config', () => {
    expect(() => NetworkConfigSchema.parse({ network: 'testnet', passphrase: 'x', rpcUrls: [], assets: {} })).toThrow()
    expect(() => buildRegistry('not a url')).toThrow()
  })
  it('persists and switches the selected network', () => {
    expect(getSelectedNetwork()).toBeNull()
    setSelectedNetwork('futurenet')
    expect(getSelectedNetwork()).toBe('futurenet')
  })
  it('maps passphrases', () => {
    expect(networkFromPassphrase(NETWORK_PASSPHRASES.mainnet)).toBe('mainnet')
    expect(networkFromPassphrase('nope')).toBeNull()
  })
  it('isolates caches per network', () => {
    const c = new NetworkScopedCache<number>()
    c.set('mainnet', 'XLM', 1)
    expect(c.get('testnet', 'XLM')).toBeUndefined()
    expect(networkCacheKey('mainnet', 'a')).not.toBe(networkCacheKey('testnet', 'a'))
    c.clearNetwork('mainnet')
    expect(c.get('mainnet', 'XLM')).toBeUndefined()
  })
})
