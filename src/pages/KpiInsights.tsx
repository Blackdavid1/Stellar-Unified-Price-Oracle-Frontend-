import { activation, featureAdoption, funnel, retentionCohorts } from '../telemetry/kpi'
import { readBuffer } from '../telemetry/telemetry'

const pct = (n: number) => `${Math.round(n * 100)}%`

/** Developer-only KPI funnels rendered from the local telemetry buffer. */
export default function KpiInsights() {
  const events = readBuffer()
  const act = activation(events)
  const steps = funnel(events, ['route_viewed', 'dashboard_loaded', 'feature_used'])
  const max = Math.max(1, ...steps.map((s) => s.installs))
  return (
    <main className="mx-auto max-w-3xl p-4 text-slate-200" data-testid="kpi-insights">
      <h1 className="text-xl font-semibold">Product KPIs (local buffer)</h1>
      <p className="text-sm text-slate-400">{events.length} events. Requires telemetry consent to populate.</p>
      <h2 className="mt-4 font-medium">Activation</h2>
      <p>{act.activated} / {act.installs} installs ({pct(act.rate)})</p>
      <h2 className="mt-4 font-medium">Funnel</h2>
      {steps.map((s) => (
        <div key={s.step} className="my-1">
          <div className="text-xs">{s.step}: {s.installs}</div>
          <div className="h-3 rounded bg-sky-500" style={{ width: `${(s.installs / max) * 100}%` }} />
        </div>
      ))}
      <h2 className="mt-4 font-medium">Feature adoption</h2>
      <ul>{featureAdoption(events).map((f) => <li key={f.feature}>{f.feature}: {pct(f.rate)}</li>)}</ul>
      <h2 className="mt-4 font-medium">Weekly retention cohorts</h2>
      <table className="text-sm">
        <tbody>
          {retentionCohorts(events).map((c) => (
            <tr key={c.cohortStart}>
              <td className="pr-3">{new Date(c.cohortStart).toISOString().slice(0, 10)} (n={c.size})</td>
              {c.retained.map((r, i) => <td key={i} className="pr-2">{pct(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
