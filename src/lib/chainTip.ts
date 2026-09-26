/**
 * Chain-tip consistency: every on-chain read is pinned to a ledger sequence
 * and recorded with its ledger hash. If a hash later differs for a sequence we
 * already saw, records anchored there are flipped to `reorged`. Lagging RPCs
 * are excluded from "latest" via the provider pool (see rpcFailover.ts).
 *
 * Assumption: the backend/RPC read returns `{ ledger, ledgerHash }` alongside
 * the value. The existing `/api/onchain` endpoint only returns `ledger`, so
 * `ledgerHash` is optional and hash-drift detection needs it to be present.
 */
import type { RpcProviderPool } from './rpcFailover'

export type AnchorStatus = 'anchored' | 'reorged'

export interface LedgerAnchor {
  sequence: number
  ledgerHash?: string
  status: AnchorStatus
  observedAt: number
}

export interface PinnedRead<T> {
  value: T
  anchor: LedgerAnchor
  provider: string
}

export interface RawLedgerRead<T> {
  value: T
  ledger: number
  ledgerHash?: string
}

const KEY = 'spo.chainAnchors.v1'
const MAX_ENTRIES = 500

export class AnchorStore {
  private hashes = new Map<number, string>()
  private records = new Map<string, LedgerAnchor>()

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    try {
      const raw = storage?.getItem(KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { hashes: [number, string][]; records: [string, LedgerAnchor][] }
        this.hashes = new Map(parsed.hashes)
        this.records = new Map(parsed.records)
      }
    } catch {
      /* corrupt store: start clean */
    }
  }

  private persist(): void {
    try {
      while (this.hashes.size > MAX_ENTRIES) this.hashes.delete(this.hashes.keys().next().value as number)
      this.storage?.setItem(
        KEY,
        JSON.stringify({ hashes: [...this.hashes], records: [...this.records] }),
      )
    } catch {
      /* quota: non-fatal */
    }
  }

  /**
   * Records an observation of `sequence`/`hash` for `recordKey`. A different
   * hash for a known sequence marks every record anchored at that sequence
   * `reorged`, and returns the new (reorged) anchor for this record.
   */
  observe(recordKey: string, sequence: number, ledgerHash: string | undefined, now = Date.now()): LedgerAnchor {
    let status: AnchorStatus = 'anchored'
    const known = this.hashes.get(sequence)
    if (ledgerHash) {
      if (known !== undefined && known !== ledgerHash) {
        status = 'reorged'
        for (const [k, a] of this.records) {
          if (a.sequence === sequence) this.records.set(k, { ...a, status: 'reorged' })
        }
      }
      this.hashes.set(sequence, ledgerHash) // latest hash wins
    }
    const anchor: LedgerAnchor = { sequence, ledgerHash, status, observedAt: now }
    this.records.set(recordKey, anchor)
    this.persist()
    return anchor
  }

  get(recordKey: string): LedgerAnchor | undefined {
    return this.records.get(recordKey)
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Reads through the provider pool, pinning and recording the ledger sequence.
 * Providers whose tip lags the best known tip are excluded by the pool; a
 * result from a provider that is itself stale is rejected and the next is tried.
 */
export async function pinnedRead<T>(
  pool: RpcProviderPool,
  store: AnchorStore,
  recordKey: string,
  read: (url: string, signal: AbortSignal) => Promise<RawLedgerRead<T>>,
): Promise<PinnedRead<T>> {
  const { value: raw, url } = await pool.call(async (u, signal) => {
    const r = await read(u, signal)
    pool.recordLedger(u, r.ledger)
    if (pool.isStale(u)) throw new Error(`RPC ${u} tip ${r.ledger} is stale`)
    return r
  })
  return { value: raw.value, provider: url, anchor: store.observe(recordKey, raw.ledger, raw.ledgerHash) }
}
