/** Pure KPI definitions over the local telemetry buffer. */
import type { TelemetryEvent } from './schema'

const DAY = 86_400_000

/** Activation: share of installs with at least one successful dashboard load. */
export function activation(events: TelemetryEvent[]): { installs: number; activated: number; rate: number } {
  const all = new Set(events.map((e) => e.installId))
  const act = new Set(
    events.filter((e) => e.name === 'dashboard_loaded' && e.props.success === true).map((e) => e.installId),
  )
  return { installs: all.size, activated: act.size, rate: all.size ? act.size / all.size : 0 }
}

/** Feature adoption: distinct installs using each feature / all installs. */
export function featureAdoption(events: TelemetryEvent[]): { feature: string; installs: number; rate: number }[] {
  const all = new Set(events.map((e) => e.installId)).size
  const by = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.name !== 'feature_used') continue
    const f = String(e.props.feature)
    if (!by.has(f)) by.set(f, new Set())
    by.get(f)!.add(e.installId)
  }
  return [...by]
    .map(([feature, s]) => ({ feature, installs: s.size, rate: all ? s.size / all : 0 }))
    .sort((a, b) => b.installs - a.installs)
}

/**
 * Weekly retention cohorts: installs grouped by week of first event; for each
 * week offset, the fraction active. `cohortStart` is the epoch ms of the cohort week.
 */
export function retentionCohorts(events: TelemetryEvent[]): { cohortStart: number; size: number; retained: number[] }[] {
  const WEEK = 7 * DAY
  const perInstall = new Map<string, number[]>()
  for (const e of events) {
    const w = Math.floor(e.ts / WEEK)
    perInstall.set(e.installId, [...(perInstall.get(e.installId) ?? []), w])
  }
  const cohorts = new Map<number, string[]>()
  for (const [id, weeks] of perInstall) {
    const first = Math.min(...weeks)
    cohorts.set(first, [...(cohorts.get(first) ?? []), id])
  }
  const lastWeek = Math.max(0, ...[...perInstall.values()].flat())
  return [...cohorts]
    .sort((a, b) => a[0] - b[0])
    .map(([first, ids]) => {
      const retained: number[] = []
      for (let off = 0; first + off <= lastWeek; off++) {
        const n = ids.filter((id) => perInstall.get(id)!.includes(first + off)).length
        retained.push(n / ids.length)
      }
      return { cohortStart: first * WEEK, size: ids.length, retained }
    })
}

/** Simple funnel: installs reaching each ordered step (by event name). */
export function funnel(events: TelemetryEvent[], steps: TelemetryEvent['name'][]): { step: string; installs: number }[] {
  let pool: Set<string> | null = null
  return steps.map((step) => {
    const at = new Set(events.filter((e) => e.name === step).map((e) => e.installId))
    pool = pool ? new Set([...pool].filter((id) => at.has(id))) : at
    return { step, installs: pool.size }
  })
}
