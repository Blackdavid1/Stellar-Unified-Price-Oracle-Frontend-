import { describe, it, expect } from 'vitest'
import { activation, featureAdoption, retentionCohorts, funnel } from './kpi'
import type { TelemetryEvent } from './schema'

const WEEK = 7 * 86_400_000
const ev = (installId: string, name: TelemetryEvent['name'], props: Record<string, unknown>, ts = 0): TelemetryEvent =>
  ({ v: 1, name, installId, ts, props })

const events = [
  ev('a', 'dashboard_loaded', { success: true }),
  ev('b', 'dashboard_loaded', { success: false }),
  ev('a', 'feature_used', { feature: 'alerts' }),
  ev('a', 'route_viewed', { route: 'dashboard' }, WEEK),
]

describe('kpi', () => {
  it('activation', () => expect(activation(events)).toEqual({ installs: 2, activated: 1, rate: 0.5 }))
  it('adoption', () => expect(featureAdoption(events)).toEqual([{ feature: 'alerts', installs: 1, rate: 0.5 }]))
  it('retention', () => {
    const c = retentionCohorts(events)
    expect(c).toHaveLength(1)
    expect(c[0].size).toBe(2)
    expect(c[0].retained).toEqual([1, 0.5])
  })
  it('funnel', () =>
    expect(funnel(events, ['dashboard_loaded', 'feature_used'])).toEqual([
      { step: 'dashboard_loaded', installs: 2 },
      { step: 'feature_used', installs: 1 },
    ]))
})
