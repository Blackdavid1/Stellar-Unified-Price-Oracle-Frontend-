import { beforeEach, describe, expect, it } from 'vitest'
import {
  breakdown,
  classifyDevice,
  evaluateFieldGate,
  loadFieldSamples,
  normalizeRoute,
  percentile,
  pruneSamples,
  recordFieldVital,
  setFieldVitalsConsent,
  type FieldVitalSample,
} from './fieldVitals'

const ctx = { pathname: '/pairs/12345678?x=1', width: 500, connection: '4g' }

describe('fieldVitals', () => {
  beforeEach(() => localStorage.clear())

  it('does not record without consent', () => {
    expect(recordFieldVital({ name: 'LCP', value: 1000 }, ctx)).toBe(false)
    expect(loadFieldSamples()).toEqual([])
  })

  it('records attributed, identifier-free samples with consent', () => {
    setFieldVitalsConsent(true)
    expect(recordFieldVital({ name: 'INP', value: 120 }, ctx, 1)).toBe(true)
    const [s] = loadFieldSamples()
    expect(s).toEqual({ name: 'INP', value: 120, route: '/pairs/:id', device: 'mobile', connection: '4g', at: 1 })
    expect(Object.keys(s)).not.toContain('id')
  })

  it('revoking consent clears stored data', () => {
    setFieldVitalsConsent(true)
    recordFieldVital({ name: 'CLS', value: 0.05 }, ctx)
    setFieldVitalsConsent(false)
    expect(loadFieldSamples()).toEqual([])
  })

  it('computes nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1)
    expect([percentile(v, 50), percentile(v, 75), percentile(v, 95)]).toEqual([50, 75, 95])
    expect(percentile([], 50)).toBeNull()
  })

  it('prunes by age and per-metric count', () => {
    const mk = (at: number): FieldVitalSample => ({ name: 'LCP', value: at, route: '/', device: 'desktop', connection: 'x', at })
    const out = pruneSamples([mk(1), mk(90), mk(95), mk(100)], 100, 20, 2)
    expect(out.map((s) => s.at)).toEqual([95, 100])
  })

  it('breaks down by dimension and classifies devices', () => {
    expect(classifyDevice(1200)).toBe('desktop')
    expect(normalizeRoute('/a/b#h')).toBe('/a/b')
    const base = { name: 'LCP' as const, route: '/', connection: 'x', at: 1 }
    const b = breakdown(
      [
        { ...base, value: 1, device: 'mobile' },
        { ...base, value: 3, device: 'desktop' },
      ],
      'LCP',
      'device',
    )
    expect(b.mobile.p75).toBe(1)
    expect(b.desktop.count).toBe(1)
  })

  it('gates on field p75 and abstains with too little data', () => {
    const base = { route: '/', device: 'desktop' as const, connection: 'x', at: 1 }
    const samples = Array.from({ length: 20 }, () => ({ ...base, name: 'INP' as const, value: 300 }))
    const gate = evaluateFieldGate(samples)
    expect(gate.find((g) => g.name === 'INP')?.pass).toBe(false)
    expect(gate.find((g) => g.name === 'LCP')?.pass).toBeNull()
  })
})
