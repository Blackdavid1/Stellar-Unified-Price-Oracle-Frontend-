/**
 * Per-network oracle registry (#633).
 *
 * One validated record per Stellar network: passphrase, oracle contract ids
 * (from {@link contractRegistry}), Soroban RPC endpoints and asset mapping.
 * The registry is Zod-validated at module load so a bad config fails fast.
 * The developer network choice is persisted via `utils/storage` and every
 * cache key is namespaced by network so data never crosses networks.
 */
import { z } from 'zod'
import { listRegisteredAssets, getContractAddress, isOracleNetwork, ORACLE_NETWORKS, type OracleNetwork } from './contractRegistry'
import { parseProviderList } from './rpcFailover'
import { STORAGE_KEYS, readRaw, writeRaw, remove } from '../utils/storage'

export const NETWORK_PASSPHRASES: Record<OracleNetwork, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
}

const DEFAULT_RPC: Record<OracleNetwork, string[]> = {
  mainnet: ['https://soroban-rpc.mainnet.stellar.gateway.fm'],
  testnet: ['https://soroban-testnet.stellar.org'],
  futurenet: ['https://rpc-futurenet.stellar.org'],
}

export const NetworkConfigSchema = z.object({
  network: z.enum(['mainnet', 'testnet', 'futurenet']),
  passphrase: z.string().min(1),
  rpcUrls: z.array(z.string().url()).min(1),
  /** Base asset code -> oracle contract id (StrKey C...). */
  assets: z.record(z.string().min(1), z.string().regex(/^C[A-Z2-7]{55}$/)),
})
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>

export const RegistrySchema = z.object({
  mainnet: NetworkConfigSchema,
  testnet: NetworkConfigSchema,
  futurenet: NetworkConfigSchema,
})
export type NetworkRegistry = z.infer<typeof RegistrySchema>

export function buildRegistry(rpcOverride?: string): NetworkRegistry {
  const out: Record<string, unknown> = {}
  for (const network of ORACLE_NETWORKS) {
    const assets: Record<string, string> = {}
    for (const a of listRegisteredAssets(network)) assets[a] = getContractAddress(network, a)
    // VITE_SOROBAN_RPC_URLS (rpcFailover pool) applies to the build-time default network only.
    out[network] = { network, passphrase: NETWORK_PASSPHRASES[network], rpcUrls: DEFAULT_RPC[network], assets }
  }
  const registry = RegistrySchema.parse(out) // throws (fail fast) on a bad registry
  const extra = parseProviderList(rpcOverride)
  if (extra.length) {
    const net = (import.meta.env.VITE_ORACLE_NETWORK as string | undefined) ?? 'testnet'
    if (isOracleNetwork(net)) registry[net].rpcUrls = z.array(z.string().url()).min(1).parse(extra)
  }
  return registry
}

const REGISTRY: NetworkRegistry = buildRegistry(import.meta.env.VITE_SOROBAN_RPC_URLS as string | undefined)

export function getNetworkConfig(network: OracleNetwork): NetworkConfig {
  return REGISTRY[network]
}

export function networkFromPassphrase(passphrase: string | null | undefined): OracleNetwork | null {
  return ORACLE_NETWORKS.find((n) => NETWORK_PASSPHRASES[n] === passphrase) ?? null
}

/** Network switching is a developer feature (`VITE_DEV_NETWORK_SWITCH=true`, or dev builds). */
export function isNetworkSwitchEnabled(): boolean {
  return import.meta.env.VITE_DEV_NETWORK_SWITCH === 'true' || import.meta.env.DEV === true
}

export function getSelectedNetwork(): OracleNetwork | null {
  if (!isNetworkSwitchEnabled()) return null
  const raw = readRaw(STORAGE_KEYS.activeNetwork)
  return raw && isOracleNetwork(raw) ? raw : null
}

type Listener = (n: OracleNetwork) => void
const listeners = new Set<Listener>()
export function onNetworkChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setSelectedNetwork(network: OracleNetwork): boolean {
  if (!isNetworkSwitchEnabled() || !isOracleNetwork(network)) return false
  const ok = writeRaw(STORAGE_KEYS.activeNetwork, network)
  listeners.forEach((l) => l(network))
  return ok
}

export function clearSelectedNetwork(): void {
  remove(STORAGE_KEYS.activeNetwork)
}

/** Namespaces a cache key by network so mainnet data never appears in a testnet view. */
export function networkCacheKey(network: OracleNetwork, key: string): string {
  return `${network}:${key}`
}

/** Minimal network-scoped in-memory cache; reads only ever see the given network's entries. */
export class NetworkScopedCache<T> {
  private store = new Map<string, T>()
  get(network: OracleNetwork, key: string): T | undefined {
    return this.store.get(networkCacheKey(network, key))
  }
  set(network: OracleNetwork, key: string, value: T): void {
    this.store.set(networkCacheKey(network, key), value)
  }
  clearNetwork(network: OracleNetwork): void {
    for (const k of [...this.store.keys()]) if (k.startsWith(`${network}:`)) this.store.delete(k)
  }
}
