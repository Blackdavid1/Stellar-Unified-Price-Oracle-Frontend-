import type { LedgerAnchor } from '../lib/chainTip'

/** Shows the ledger sequence a proof/read is anchored to, and flags reorgs. */
export function LedgerAnchorBadge({ anchor }: { anchor: LedgerAnchor | undefined }) {
  if (!anchor) return null
  const reorged = anchor.status === 'reorged'
  return (
    <span
      data-testid="ledger-anchor"
      className={reorged ? 'text-red-400' : 'text-slate-400'}
      title={anchor.ledgerHash ? `Ledger hash ${anchor.ledgerHash}` : 'Ledger hash unavailable'}
    >
      Ledger #{anchor.sequence}
      {reorged ? ' (reorged: re-verify)' : ''}
    </span>
  )
}
