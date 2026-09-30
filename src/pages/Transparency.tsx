import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePriceContext } from '../context/PriceContext'
import { useSwr } from '../hooks/useSwr'
import { fetchGovernanceProposals } from '../api/rest'
import {
  buildTransparencyReport,
  ensureScheduledSnapshot,
  loadArchive,
  type TransparencyArchive,
  type TransparencyReport,
} from '../utils/transparencyReport'

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

function ReportView({ report }: { report: TransparencyReport }): ReactElement {
  return (
    <div className="flex flex-col gap-6 text-sm">
      <p className="text-gray-500">Generated {new Date(report.generatedAt).toUTCString()}</p>
      <section aria-labelledby="tr-sources">
        <h2 id="tr-sources" className="text-lg font-semibold mb-2">
          Source uptime &amp; accuracy
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1">Source</th>
                <th>Uptime</th>
                <th>Accuracy (mean confidence)</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((s) => (
                <tr key={s.source} className="border-t border-gray-200 dark:border-gray-800">
                  <td className="py-1 capitalize">{s.source}</td>
                  <td>{pct(s.uptime)}</td>
                  <td>{pct(s.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="tr-gov">
        <h2 id="tr-gov" className="text-lg font-semibold mb-2">
          Governance
        </h2>
        <p>
          {report.proposals.total} proposals ({report.proposals.active} active, {report.proposals.passed} passed,{' '}
          {report.proposals.rejected} rejected) · {report.totalVotesCast.toLocaleString()} voting power cast · mean
          participation {report.meanParticipation === null ? '—' : `${report.meanParticipation.toFixed(1)}%`}
        </p>
      </section>
      <section aria-labelledby="tr-inc">
        <h2 id="tr-inc" className="text-lg font-semibold mb-2">
          Incidents
        </h2>
        {report.incidents.length === 0 ? (
          <p>No incidents this period.</p>
        ) : (
          <ul className="list-disc ps-5">
            {report.incidents.map((i) => (
              <li key={i.id}>
                {i.date} — {i.title} (
                <a href={i.postmortemUrl} target="_blank" rel="noopener noreferrer" className="underline text-cyan-600">
                  postmortem {i.id}
                </a>
                )
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Stable transparency report page with a dated archive (#700). */
export function Transparency(): ReactElement {
  const { prices } = usePriceContext()
  const { data: proposals } = useSwr('governance/proposals', (signal) => fetchGovernanceProposals(signal), {
    staleTime: 30_000,
  })
  const [params, setParams] = useSearchParams()
  const [archive, setArchive] = useState<TransparencyArchive>(loadArchive)

  const current = useMemo(() => buildTransparencyReport(prices, proposals ?? []), [prices, proposals])

  // Scheduled generation: snapshot once per period, only once data has loaded.
  useEffect(() => {
    if (prices.length > 0 && proposals) setArchive((a) => ensureScheduledSnapshot(current, a))
  }, [current, prices.length, proposals])

  const period = params.get('period')
  const report = period && archive[period] ? archive[period] : current
  const periods = Object.keys(archive).sort().reverse()

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Transparency report — {report.period}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Published monthly from the same metrics shown on the dashboard and governance pages.
        </p>
      </header>
      <nav aria-label="Report archive" className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={() => setParams({})}
          className={`px-2 py-1 rounded border ${!period ? 'bg-cyan-600 text-white' : ''}`}
        >
          Live
        </button>
        {periods.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setParams({ period: p })}
            className={`px-2 py-1 rounded border ${period === p ? 'bg-cyan-600 text-white' : ''}`}
          >
            {p}
          </button>
        ))}
      </nav>
      <ReportView report={report} />
    </div>
  )
}
