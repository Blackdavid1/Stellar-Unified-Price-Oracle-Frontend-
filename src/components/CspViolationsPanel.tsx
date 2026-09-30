import { memo, useEffect, useMemo, useState } from 'react'
import {
  clearCspViolations,
  exportCspViolations,
  getCspViolations,
  getTopDirectives,
  subscribeCspViolations,
  type CspViolation,
} from '../utils/cspReporting'

function download(content: string, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  a.download = filename
  a.click()
}

type ViolationSource = 'extension' | 'injected' | 'first-party' | 'unknown'

const EXTENSION_SCHEMES = ['chrome-extension://', 'moz-extension://', 'safari-extension://', 'ms-browser-extension://']
const INJECTED_HINTS = ['eval', 'data:', 'blob:', 'javascript:']

/**
 * Classify a CSP violation by source so triage can separate benign noise
 * (browser extensions, injected scripts) from real first-party regressions.
 */
function classifyViolation(v: CspViolation): ViolationSource {
  const uri = v.blockedUri ?? ''
  const source = v.sourceFile ?? ''
  if (EXTENSION_SCHEMES.some((s) => uri.startsWith(s) || source.startsWith(s))) return 'extension'
  if (INJECTED_HINTS.some((h) => uri.startsWith(h) || source.startsWith(h))) return 'injected'
  if (source && !EXTENSION_SCHEMES.some((s) => source.startsWith(s))) return 'first-party'
  return 'unknown'
}

const SOURCE_STYLES: Record<ViolationSource, string> = {
  'first-party': 'bg-red-950 text-red-300',
  injected: 'bg-amber-950 text-amber-300',
  extension: 'bg-gray-800 text-gray-400',
  unknown: 'bg-blue-950 text-blue-300',
}

const SOURCE_LABELS: Record<ViolationSource, string> = {
  'first-party': 'First-party',
  injected: 'Injected',
  extension: 'Extension',
  unknown: 'Unknown',
}

export const CspViolationsPanel = memo(function CspViolationsPanel() {
  const [violations, setViolations] = useState<CspViolation[]>(() => getCspViolations())

  useEffect(() => subscribeCspViolations(setViolations), [])

  const topDirectives = getTopDirectives()

  // Deduplicate by directive + blocked URI + source so repeated reports collapse
  // into a single reviewable entry with an occurrence count.
  const triaged = useMemo(() => {
    const map = new Map<string, { violation: CspViolation; source: ViolationSource; count: number }>()
    for (const v of violations) {
      const source = classifyViolation(v)
      const key = `${v.directive}|${v.blockedUri}|${v.sourceFile ?? ''}|${v.lineNumber ?? ''}`
      const existing = map.get(key)
      if (existing) existing.count += 1
      else map.set(key, { violation: v, source, count: 1 })
    }
    return Array.from(map.values())
  }, [violations])

  const firstPartyCount = triaged.filter((t) => t.source === 'first-party').length

  return (
    <section className="bg-gray-900 rounded-lg p-4 space-y-3" aria-label="CSP violations">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-white">CSP Violations ({violations.length})</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => download(exportCspViolations(), 'csp-violations.json')}
            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            Export
          </button>
          <button
            onClick={clearCspViolations}
            className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white"
          >
            Clear
          </button>
        </div>
      </div>

      {firstPartyCount > 0 && (
        <p
          role="alert"
          className="text-xs rounded px-2 py-1 bg-red-950 text-red-300 border border-red-800"
        >
          {firstPartyCount} first-party violation(s) detected — these fail the regression gate.
        </p>
      )}

      {topDirectives.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-gray-400">Top violating directives</h4>
          <ul className="flex flex-wrap gap-1.5" role="list">
            {topDirectives.slice(0, 5).map(({ directive, count }) => (
              <li
                key={directive}
                className="text-xs font-mono rounded px-2 py-0.5 bg-amber-950 text-amber-300"
                title={`${count} violation(s)`}
              >
                {directive} × {count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {triaged.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No CSP violations captured.</p>
      ) : (
        <ul className="space-y-1 max-h-64 overflow-y-auto" role="list">
          {triaged.map(({ violation: v, source, count }, i) => (
            <li
              key={i}
              className={`flex items-start justify-between gap-2 text-xs rounded px-2 py-1 ${SOURCE_STYLES[source]}`}
            >
              <span className="break-all flex-1">
                <span className="font-semibold">{v.directive}</span> blocked{' '}
                <span className="font-mono">{v.blockedUri}</span>
                {v.sourceFile && (
                  <span className="text-gray-500">
                    {' '}
                    at {v.sourceFile}
                    {v.lineNumber ? `:${v.lineNumber}` : ''}
                  </span>
                )}
                {count > 1 && <span className="text-gray-500"> × {count}</span>}
              </span>
              <span className="shrink-0 uppercase tracking-wide text-[10px] font-bold">
                {SOURCE_LABELS[source]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
})
