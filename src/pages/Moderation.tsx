import { useMemo, useState, type ReactElement } from 'react'
import {
  CODE_OF_CONDUCT_URL,
  DECISIONS,
  advanceReport,
  decideReport,
  loadReports,
  moderationStats,
  saveReports,
  type ModerationDecision,
  type ModerationReport,
} from '../utils/moderation'

function StatList({ title, data }: { title: string; data: Record<string, number> }): ReactElement {
  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 p-3">
      <h3 className="font-medium mb-2">{title}</h3>
      <dl className="grid grid-cols-2 gap-1 text-sm">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Moderation queue + published anonymized stats (#699). */
export function Moderation(): ReactElement {
  const [reports, setReports] = useState<ModerationReport[]>(loadReports)
  const [decisions, setDecisions] = useState<Record<string, ModerationDecision>>({})
  const [rationales, setRationales] = useState<Record<string, string>>({})
  const stats = useMemo(() => moderationStats(reports), [reports])

  const update = (next: ModerationReport) => {
    const list = reports.map((r) => (r.id === next.id ? next : r))
    setReports(list)
    saveReports(list)
  }

  const median = stats.medianTimeToDecisionMs
  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Community moderation</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Reports follow triage → decide → action → notify, enforced against our{' '}
          <a href={CODE_OF_CONDUCT_URL} target="_blank" rel="noopener noreferrer" className="underline text-cyan-600">
            Code of Conduct
          </a>
          .
        </p>
      </header>

      <section aria-labelledby="mod-stats">
        <h2 id="mod-stats" className="text-lg font-semibold mb-3">
          Transparency statistics (anonymized)
        </h2>
        <p className="text-sm mb-3">
          {stats.total} reports · median time to decision:{' '}
          {median === null ? '—' : `${Math.round(median / 3_600_000)} h`}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatList title="By category" data={stats.byCategory} />
          <StatList title="By stage" data={stats.byStage} />
          <StatList title="By decision" data={stats.byDecision} />
        </div>
      </section>

      <section aria-labelledby="mod-queue">
        <h2 id="mod-queue" className="text-lg font-semibold mb-3">
          Moderator queue
        </h2>
        {reports.length === 0 ? (
          <p className="text-sm text-gray-500">No reports yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {reports.map((r) => (
              <li
                key={r.id}
                className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm flex flex-col gap-2"
              >
                <div className="flex flex-wrap gap-2 justify-between">
                  <span>
                    <strong>{r.category}</strong> on {r.surface} · <code>{r.targetId}</code>
                  </span>
                  <span className="uppercase text-xs text-gray-500">{r.stage}</span>
                </div>
                <p className="text-gray-600 dark:text-gray-400">
                  {r.confidential ? '[confidential evidence — moderators only]' : r.evidence}
                </p>
                {r.decision && (
                  <p>
                    Decision: <strong>{r.decision}</strong>
                    {r.rationale ? ` — ${r.rationale}` : ''}
                  </p>
                )}
                {r.stage === 'triage' ? (
                  <div className="flex flex-wrap gap-2 items-center">
                    <select
                      aria-label="Decision"
                      value={decisions[r.id] ?? 'no-violation'}
                      onChange={(e) => setDecisions({ ...decisions, [r.id]: e.target.value as ModerationDecision })}
                      className="rounded border px-2 py-1 dark:bg-gray-800"
                    >
                      {DECISIONS.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Rationale"
                      placeholder="Rationale"
                      value={rationales[r.id] ?? ''}
                      onChange={(e) => setRationales({ ...rationales, [r.id]: e.target.value })}
                      className="flex-1 rounded border px-2 py-1 dark:bg-gray-800"
                    />
                    <button
                      type="button"
                      className="px-3 py-1 rounded bg-cyan-600 text-white"
                      onClick={() => update(decideReport(r, decisions[r.id] ?? 'no-violation', rationales[r.id] ?? ''))}
                    >
                      Record decision
                    </button>
                  </div>
                ) : (
                  r.stage !== 'notified' && (
                    <button
                      type="button"
                      className="self-start px-3 py-1 rounded border"
                      onClick={() => update(advanceReport(r))}
                    >
                      Mark {r.stage === 'decided' ? 'actioned' : 'reporter notified'}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
