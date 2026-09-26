import { describe, expect, it } from 'vitest'
import type { AlertCondition, ConditionGroup } from '../types'
import { evaluateCompoundCondition } from './alertEvaluator'
import { cronMatches, isScheduleActive, wallClock } from './alertSchedule'

/** Minimal deterministic fake clock (no virtual-clock utility exists in the repo). */
class FakeClock {
  constructor(public now: number) {}
  advance(ms: number) { this.now += ms }
}

const NY = 'America/New_York'

describe('alertSchedule', () => {
  it('reads wall clock in the target zone', () => {
    // 2024-01-15 14:30Z = 09:30 EST Monday
    expect(wallClock(Date.UTC(2024, 0, 15, 14, 30), NY)).toMatchObject({ hour: 9, minute: 30, dayOfWeek: 1 })
  })

  it('market-open window is timezone- and DST-correct', () => {
    const spec = { timeZone: NY, daysOfWeek: [1, 2, 3, 4, 5], window: { start: '09:30', end: '16:00' } }
    // Winter (EST, UTC-5): 14:30Z is open, 14:29Z is not.
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 15, 14, 30))).toBe(true)
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 15, 14, 29))).toBe(false)
    // Summer (EDT, UTC-4): open moves to 13:30Z.
    expect(isScheduleActive(spec, Date.UTC(2024, 6, 15, 13, 30))).toBe(true)
    expect(isScheduleActive(spec, Date.UTC(2024, 6, 15, 14, 29) - 60 * 60 * 1000 - 1)).toBe(false)
    // Weekend excluded.
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 13, 15, 0))).toBe(false)
  })

  it('handles the spring-forward gap: 02:30 local never occurs but neighbours resolve', () => {
    const spec = { timeZone: NY, window: { start: '03:00', end: '04:00' } }
    // 2024-03-10 07:00Z = 03:00 EDT (first instant after the gap)
    expect(isScheduleActive(spec, Date.UTC(2024, 2, 10, 7, 0))).toBe(true)
    expect(isScheduleActive(spec, Date.UTC(2024, 2, 10, 6, 59))).toBe(false) // 01:59 EST
  })

  it('supports windows that wrap midnight', () => {
    const spec = { timeZone: 'UTC', window: { start: '22:00', end: '02:00' } }
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 1, 23, 0))).toBe(true)
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 1, 1, 0))).toBe(true)
    expect(isScheduleActive(spec, Date.UTC(2024, 0, 1, 12, 0))).toBe(false)
  })

  it('matches cron expressions', () => {
    const wc = wallClock(Date.UTC(2024, 0, 15, 9, 0), 'UTC') // Mon 09:00
    expect(cronMatches('0 9 * * 1-5', wc)).toBe(true)
    expect(cronMatches('*/15 9 * * *', wc)).toBe(true)
    expect(cronMatches('0 9 * * 0,6', wc)).toBe(false)
    expect(cronMatches('bad', wc)).toBe(false)
  })

  it('compound time + price rule evaluates with the fake clock', () => {
    const price: AlertCondition = { id: 'p', field: 'price', operator: 'lt', value: 100 }
    const time: AlertCondition = { id: 't', field: 'schedule', operator: 'eq', value: 1, schedule: { timeZone: NY, window: { start: '09:30', end: '16:00' } } }
    const group: ConditionGroup = { id: 'g', logic: 'AND', conditions: [price, time] }
    const clock = new FakeClock(Date.UTC(2024, 0, 15, 14, 0)) // 09:00 EST, closed
    expect(evaluateCompoundCondition(group, { price: 90, nowMs: clock.now })).toBe(false)
    clock.advance(30 * 60 * 1000) // 09:30 EST, open
    expect(evaluateCompoundCondition(group, { price: 90, nowMs: clock.now })).toBe(true)
    expect(evaluateCompoundCondition(group, { price: 110, nowMs: clock.now })).toBe(false)
    expect(evaluateCompoundCondition(group, { price: 90 })).toBe(false) // no clock -> inactive
  })
})
