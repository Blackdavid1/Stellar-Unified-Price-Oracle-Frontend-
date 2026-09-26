import { useState } from 'react'
import type { Alert } from '../types'
import { getRuleVersions, revertRule, recordRuleVersion, type RuleVersion } from '../services/alertRuleHistory'

interface Props {
  alert: Alert
  /** Persist the reverted rule (typically `useAlerts().updateAlert`). */
  onRevert: (id: string, updates: Partial<Omit<Alert, 'id' | 'createdAt'>>) => void
}

const fmt = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v))

/** Rule history with a before/after diff per version and one-click revert (#645). */
export function AlertRuleHistory({ alert, onRevert }: Props) {
  const [versions, setVersions] = useState<RuleVersion[]>(() => getRuleVersions(alert.id))

  const handleRevert = (v: RuleVersion) => {
    const reverted = revertRule(alert, v)
    onRevert(alert.id, reverted)
    recordRuleVersion(reverted, Date.now(), v.version)
    setVersions(getRuleVersions(alert.id))
  }

  if (versions.length === 0) return <p className="text-sm text-gray-500">No history yet.</p>

  return (
    <ol aria-label="Rule history" className="space-y-3">
      {[...versions].reverse().map((v, i) => (
        <li key={v.version} className="rounded border border-gray-700 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span>
              v{v.version} - {new Date(v.at).toLocaleString()}
              {v.revertedFrom ? ` (revert to v${v.revertedFrom})` : ''}
            </span>
            {i > 0 && (
              <button type="button" className="underline" onClick={() => handleRevert(v)}>
                Revert to this version
              </button>
            )}
          </div>
          {v.diff.length > 0 && (
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr><th className="text-left">Field</th><th className="text-left">Before</th><th className="text-left">After</th></tr>
              </thead>
              <tbody>
                {v.diff.map((d) => (
                  <tr key={d.key}>
                    <td>{d.key}</td>
                    <td className="text-red-400">{fmt(d.before)}</td>
                    <td className="text-green-400">{fmt(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </li>
      ))}
    </ol>
  )
}
