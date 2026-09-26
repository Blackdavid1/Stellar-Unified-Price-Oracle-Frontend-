/**
 * @file Schedule / time-predicate evaluation for alert rules (#646).
 *
 * Pure functions of (spec, instant). Wall-clock parts are derived with
 * `Intl.DateTimeFormat` in the spec's IANA zone, so DST transitions and offsets come
 * from the platform tz database rather than hand-rolled math.
 *
 * Assumptions: the repo has no skew-corrected timeline (#601) or virtual clock (#609)
 * yet, so the instant is passed in explicitly (`PriceEvaluationState.nowMs`); callers
 * can feed a skew-corrected time or a fake clock without changes here. A recurrence
 * evaluated only when prices tick is level-triggered (active while the window is open).
 */
import type { ScheduleSpec } from '../types'

export interface WallClock {
  minute: number
  hour: number
  dayOfMonth: number
  month: number // 1-12
  dayOfWeek: number // 0-6, Sunday = 0
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function wallClock(nowMs: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(nowMs))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    dayOfMonth: Number(get('day')),
    month: Number(get('month')),
    dayOfWeek: DOW[get('weekday')] ?? 0,
  }
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? h * 60 + min : null
}

/** Expands one cron field into the set of matching values, or null if invalid. */
function cronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/')
    const step = stepStr === undefined ? 1 : Number(stepStr)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (/^\d+-\d+$/.test(range)) {
      ;[lo, hi] = range.split('-').map(Number)
    } else if (/^\d+$/.test(range)) {
      lo = Number(range)
      hi = stepStr === undefined ? lo : max
    } else return null
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** True when `wc` matches the 5-field cron expression; invalid cron never matches. */
export function cronMatches(cron: string, wc: WallClock): boolean {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return false
  const [mi, h, dom, mo, dow] = [
    cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4], 0, 7),
  ]
  if (!mi || !h || !dom || !mo || !dow) return false
  if (dow.has(7)) dow.add(0)
  const domStar = f[2].startsWith('*')
  const dowStar = f[4].startsWith('*')
  const domOk = dom.has(wc.dayOfMonth)
  const dowOk = dow.has(wc.dayOfWeek)
  // Standard cron: when both day fields are restricted, either may match.
  const dayOk = !domStar && !dowStar ? domOk || dowOk : domOk && dowOk
  return mi.has(wc.minute) && h.has(wc.hour) && mo.has(wc.month) && dayOk
}

/** Whether `spec` is active at `nowMs`. Invalid zones/times evaluate to false. */
export function isScheduleActive(spec: ScheduleSpec, nowMs: number): boolean {
  let wc: WallClock
  try {
    wc = wallClock(nowMs, spec.timeZone)
  } catch {
    return false
  }
  if (spec.daysOfWeek && !spec.daysOfWeek.includes(wc.dayOfWeek)) return false
  if (spec.window) {
    const start = parseHHMM(spec.window.start)
    const end = parseHHMM(spec.window.end)
    if (start === null || end === null) return false
    const cur = wc.hour * 60 + wc.minute
    const inWindow = start <= end ? cur >= start && cur < end : cur >= start || cur < end
    if (!inWindow) return false
  }
  if (spec.cron !== undefined && !cronMatches(spec.cron, wc)) return false
  return true
}
