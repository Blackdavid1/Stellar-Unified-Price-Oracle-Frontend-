/**
 * Settlement history (#634): indexes oracle contract events into a bounded local
 * store, one round per event, keyed by network + pair.
 *
 * ASSUMPTION (documented gap): the oracle contract emits a `publish` event per
 * settled round whose decoded value carries `{ pair, price }`; Soroban RPC
 * `getEvents` is queried with `xdrFormat: "json"` so no XDR decoding lives here.
 * The event shape is not defined in this frontend repo.
 *
 * Retention/compaction mirrors the time-series store (#618): recent rounds are
 * kept in full; rounds older than `rawWindowMs` are compacted to one round per
 * hour bucket; anything older than `maxAgeMs` or beyond `maxRounds` is dropped.
 */
import type { RpcProviderPool } from '../lib/rpcFailover'
import type { OracleNetwork } from '../lib/contractRegistry'

export interface SettlementRound {
  network: OracleNetwork
  pair: string
  price: number
  /** Ledger sequence the event was emitted in (chain anchor). */
  ledger: number
  /** Ledger close time, unix ms. */
  closedAt: number
  /** Unique event id / paging token; dedupes re-ingestion. */
  id: string
}

export interface RetentionConfig {
  rawWindowMs: number
  maxAgeMs: number
  maxRounds: number
}
const HOUR = 3_600_000
const DAY = 24 * HOUR
export const DEFAULT_SETTLEMENT_RETENTION: RetentionConfig = { rawWindowMs: DAY, maxAgeMs: 30 * DAY, maxRounds: 1000 }

export class SettlementStore {
  private rounds = new Map<string, SettlementRound[]>()
  constructor(private cfg: RetentionConfig = DEFAULT_SETTLEMENT_RETENTION, private now: () => number = Date.now) {}

  private key(network: OracleNetwork, pair: string) {
    return `${network}:${pair}`
  }

  ingest(batch: SettlementRound[]): void {
    const touched = new Set<string>()
    for (const r of batch) {
      const k = this.key(r.network, r.pair)
      const list = this.rounds.get(k) ?? []
      if (!list.some((x) => x.id === r.id)) list.push(r)
      this.rounds.set(k, list)
      touched.add(k)
    }
    touched.forEach((k) => this.compact(k))
  }

  private compact(k: string): void {
    const now = this.now()
    let list = (this.rounds.get(k) ?? []).filter((r) => now - r.closedAt <= this.cfg.maxAgeMs)
    list.sort((a, b) => b.ledger - a.ledger)
    const seen = new Set<number>()
    list = list.filter((r) => {
      if (now - r.closedAt <= this.cfg.rawWindowMs) return true
      const bucket = Math.floor(r.closedAt / HOUR)
      if (seen.has(bucket)) return false // keep newest round per hour (list is newest first)
      seen.add(bucket)
      return true
    })
    this.rounds.set(k, list.slice(0, this.cfg.maxRounds))
  }

  /** Rounds for a network+pair, newest first. Never returns another network's rounds. */
  list(network: OracleNetwork, pair: string): SettlementRound[] {
    return [...(this.rounds.get(this.key(network, pair)) ?? [])]
  }
}

export interface Divergence {
  diverged: boolean
  latest: SettlementRound | null
  deviationPercent: number | null
}

/** Reconciles the newest indexed round against the displayed aggregate price. */
export function reconcile(rounds: SettlementRound[], aggregatePrice: number, thresholdPercent = 1): Divergence {
  const latest = rounds[0] ?? null
  if (!latest || !Number.isFinite(aggregatePrice) || aggregatePrice === 0) return { diverged: false, latest, deviationPercent: null }
  const dev = (Math.abs(latest.price - aggregatePrice) / Math.abs(aggregatePrice)) * 100
  return { diverged: dev > thresholdPercent, latest, deviationPercent: dev }
}

/** Source of oracle events; injectable so tests can mock it. */
export interface EventSource {
  fetchPage(url: string, cursor: string | null, signal: AbortSignal): Promise<{ rounds: SettlementRound[]; cursor: string | null }>
}

/** Soroban RPC `getEvents` source (assumes json-decoded event values, see file header). */
export function createRpcEventSource(contractId: string, network: OracleNetwork, startLedger: number): EventSource {
  return {
    async fetchPage(url, cursor, signal) {
      const params = cursor
        ? { pagination: { cursor, limit: 100 }, filters: [{ type: 'contract', contractIds: [contractId] }], xdrFormat: 'json' }
        : { startLedger, pagination: { limit: 100 }, filters: [{ type: 'contract', contractIds: [contractId] }], xdrFormat: 'json' }
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEvents', params }),
      })
      if (!res.ok) throw Object.assign(new Error(`RPC ${res.status}`), { status: res.status })
      const body = (await res.json()) as { result?: { events?: Array<Record<string, unknown>>; cursor?: string } }
      const rounds: SettlementRound[] = []
      for (const e of body.result?.events ?? []) {
        const v = e.value as { pair?: unknown; price?: unknown } | undefined
        if (!v || typeof v.pair !== 'string' || typeof v.price !== 'number') continue
        rounds.push({
          network,
          pair: v.pair,
          price: v.price,
          ledger: Number(e.ledger),
          closedAt: Date.parse(String(e.ledgerClosedAt)),
          id: String(e.id),
        })
      }
      return { rounds, cursor: body.result?.cursor ?? null }
    },
  }
}

/** Pages through the source via the RPC failover pool and ingests into the store. */
export async function ingestEvents(
  pool: RpcProviderPool,
  source: EventSource,
  store: SettlementStore,
  maxPages = 5,
): Promise<number> {
  let cursor: string | null = null
  let total = 0
  for (let i = 0; i < maxPages; i++) {
    const { value } = await pool.call((url, signal) => source.fetchPage(url, cursor, signal))
    store.ingest(value.rounds)
    total += value.rounds.length
    if (!value.cursor || value.rounds.length === 0) break
    cursor = value.cursor
  }
  return total
}
