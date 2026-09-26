import { useEffect, useState } from 'react'
import { getRpcPool, type ProviderHealth } from '../lib/rpcFailover'

/** Diagnostics view of Soroban RPC provider health (latency, error rate, lag, circuit). */
export function RpcHealthPanel() {
  const [rows, setRows] = useState<ProviderHealth[]>(() => getRpcPool().health())
  useEffect(() => {
    const t = setInterval(() => setRows(getRpcPool().health()), 5_000)
    return () => clearInterval(t)
  }, [])
  if (rows.length === 0) return null
  return (
    <div className="mt-2 border-t border-slate-800 pt-2" data-testid="rpc-health">
      <div className="mb-1 text-slate-500">Soroban RPC providers</div>
      {rows.map((r) => (
        <div key={r.url} className="flex justify-between gap-2">
          <span className="truncate">{r.url}</span>
          <span>
            {r.circuit} · {Math.round(r.score * 100)}% · {r.latencyMs}ms
            {r.lag > 0 ? ` · -${r.lag} ledgers` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
