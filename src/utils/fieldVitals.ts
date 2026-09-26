/**
 * @file Field Core Web Vitals store (#643).
 *
 * Bounded, local-only, consent-gated aggregation of LCP/INP/CLS samples attributed to
 * route, device class and connection type. Samples carry NO identifiers (no metric id,
 * no user/session id, no full URL - routes are normalized to their pattern).
 *
 * Assumption: there is no field-data backend, so data lives in localStorage and is
 * only visible to the current browser. Retention is bounded by age and count.
 */

export type FieldVitalName = 'LCP' | 'INP' | 'CLS'
export type DeviceClass = 'mobile' | 'tablet' | 'desktop'

export interface FieldVitalSample {
  name: FieldVitalName
  value: number
  route: string
  device: DeviceClass
  connection: string
  at: number
}

export const FIELD_VITALS_STORAGE_KEY = 'spo.fieldVitals.v1'
export const FIELD_VITALS_CONSENT_KEY = 'spo.fieldVitals.consent'
/** Retention: at most 7 days and 500 samples per metric. */
export const FIELD_VITALS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const FIELD_VITALS_MAX_PER_METRIC = 500

/** Google "good" thresholds; used as the default field budgets. */
export const FIELD_VITAL_BUDGETS: Record<FieldVitalName, number> = { LCP: 2500, INP: 200, CLS: 0.1 }

export function hasFieldVitalsConsent(): boolean {
  try {
    return localStorage.getItem(FIELD_VITALS_CONSENT_KEY) === 'granted'
  } catch {
    return false
  }
}

export function setFieldVitalsConsent(granted: boolean): void {
  try {
    if (granted) localStorage.setItem(FIELD_VITALS_CONSENT_KEY, 'granted')
    else {
      localStorage.removeItem(FIELD_VITALS_CONSENT_KEY)
      localStorage.removeItem(FIELD_VITALS_STORAGE_KEY)
    }
  } catch {
    /* storage unavailable */
  }
}

export function classifyDevice(width: number): DeviceClass {
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

/** Strips query/hash and collapses id-like segments so routes carry no identifiers. */
export function normalizeRoute(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0] || '/'
  return clean
    .split('/')
    .map((seg) => (/^(\d+|[0-9a-f]{8,}|G[A-Z2-7]{20,})$/i.test(seg) ? ':id' : seg))
    .join('/')
}

/** Nearest-rank percentile; `values` need not be sorted. Returns null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

/** Drops expired samples and keeps the newest `maxPerMetric` per metric. */
export function pruneSamples(
  samples: readonly FieldVitalSample[],
  now: number,
  maxAgeMs = FIELD_VITALS_MAX_AGE_MS,
  maxPerMetric = FIELD_VITALS_MAX_PER_METRIC,
): FieldVitalSample[] {
  const fresh = samples.filter((s) => now - s.at <= maxAgeMs).sort((a, b) => b.at - a.at)
  const counts: Record<string, number> = {}
  const kept = fresh.filter((s) => (counts[s.name] = (counts[s.name] ?? 0) + 1) <= maxPerMetric)
  return kept.sort((a, b) => a.at - b.at)
}

export interface VitalPercentiles {
  count: number
  p50: number | null
  p75: number | null
  p95: number | null
}

export function summarize(samples: readonly FieldVitalSample[]): VitalPercentiles {
  const v = samples.map((s) => s.value)
  return { count: v.length, p50: percentile(v, 50), p75: percentile(v, 75), p95: percentile(v, 95) }
}

export type VitalDimension = 'route' | 'device' | 'connection'

/** Percentiles of one metric grouped by a dimension. */
export function breakdown(
  samples: readonly FieldVitalSample[],
  name: FieldVitalName,
  dimension: VitalDimension,
): Record<string, VitalPercentiles> {
  const groups: Record<string, FieldVitalSample[]> = {}
  for (const s of samples) {
    if (s.name !== name) continue
    ;(groups[s[dimension]] ??= []).push(s)
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarize(v)]))
}

export function loadFieldSamples(): FieldVitalSample[] {
  try {
    const raw = localStorage.getItem(FIELD_VITALS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as FieldVitalSample[]) : []
  } catch {
    return []
  }
}

/** Records a sample when consent is granted. Returns whether it was stored. */
export function recordFieldVital(
  input: { name: string; value: number },
  ctx: { pathname: string; width: number; connection?: string | null },
  now: number = Date.now(),
): boolean {
  if (!hasFieldVitalsConsent()) return false
  if (input.name !== 'LCP' && input.name !== 'INP' && input.name !== 'CLS') return false
  if (!Number.isFinite(input.value)) return false
  const sample: FieldVitalSample = {
    name: input.name,
    value: input.value,
    route: normalizeRoute(ctx.pathname),
    device: classifyDevice(ctx.width),
    connection: ctx.connection ?? 'unknown',
    at: now,
  }
  try {
    localStorage.setItem(
      FIELD_VITALS_STORAGE_KEY,
      JSON.stringify(pruneSamples([...loadFieldSamples(), sample], now)),
    )
    return true
  } catch {
    return false
  }
}

export interface FieldGateResult {
  name: FieldVitalName
  p75: number | null
  budget: number
  /** null when there is not enough field data to judge. */
  pass: boolean | null
}

/**
 * Perf/INP gate fed by field data: p75 of each metric vs its budget. Needs `minSamples`
 * to judge (otherwise `pass` is null so a gate can fall back to lab numbers).
 */
export function evaluateFieldGate(
  samples: readonly FieldVitalSample[],
  budgets: Record<FieldVitalName, number> = FIELD_VITAL_BUDGETS,
  minSamples = 20,
): FieldGateResult[] {
  return (['LCP', 'INP', 'CLS'] as const).map((name) => {
    const s = summarize(samples.filter((x) => x.name === name))
    return {
      name,
      p75: s.p75,
      budget: budgets[name],
      pass: s.count < minSamples || s.p75 === null ? null : s.p75 <= budgets[name],
    }
  })
}
