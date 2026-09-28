import { useEffect, useState } from 'react'
import { getActiveNetwork, getActiveRegistryEntry } from '../lib/onChainClient'
import { getRpcPool } from '../lib/rpcFailover'
import { createRpcEventSource, ingestEvents, reconcile, SettlementStore, type SettlementRound } from './settlementStore'

const store = new SettlementStore()

/** Settlement audit timeline (#634). Hidden when no RPC providers are configured. */
export function SettlementTimeline({ pair, aggregatePrice }: { pair: string; aggregatePrice: number }) {
  const network = getActiveNetwork()
  const pool = getRpcPool()
  const [rounds, setRounds] = useState<SettlementRound[]>([])
  const [error, setError] = useState<string | null>(null)
  const enabled = pool.urls.length > 0

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const entry = getActiveRegistryEntry(pair.split('/')[0])
        // startLedger 0 lets the RPC clamp to its retention window (assumption).
        await ingestEvents(pool, createRpcEventSource(entry.contractId, network, 0), store)
        if (!cancelled) setRounds(store.list(network, pair))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load settlement history')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, pool, network, pair])

  if (!enabled) return null
  const div = reconcile(rounds, aggregatePrice)
  return (
    <section aria-label="Settlement history">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Settlement History ({network})</p>
      {error && <p role="alert">{error}</p>}
      {div.diverged && (
        <p role="alert" className="text-sm text-yellow-400">
          Divergence: latest settled round differs from the displayed aggregate by {div.deviationPercent?.toFixed(2)}%.
        </p>
      )}
      <ul>
        {rounds.slice(0, 20).map((r) => (
          <li key={r.id}>
            Ledger {r.ledger} · {new Date(r.closedAt).toISOString()} · {r.price}
          </li>
        ))}
      </ul>
    </section>
  )
}
