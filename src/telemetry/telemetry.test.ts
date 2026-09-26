import { describe, it, expect, beforeEach } from 'vitest'
import { track, setConsent, getConsent, readBuffer } from './telemetry'
import { validateEvent, containsPii } from './schema'

const base = { v: 1, ts: 0, installId: 'abcdef12-3456' }

describe('telemetry', () => {
  beforeEach(() => localStorage.clear())

  it('emits nothing before consent', () => {
    expect(getConsent()).toBe('unset')
    expect(track('feature_used', { feature: 'alerts' })).toBe(false)
    expect(readBuffer()).toEqual([])
  })

  it('records after consent and clears on revoke', () => {
    setConsent('granted')
    expect(track('feature_used', { feature: 'alerts' })).toBe(true)
    expect(readBuffer()).toHaveLength(1)
    setConsent('denied')
    expect(readBuffer()).toEqual([])
  })

  it('drops malformed events', () => {
    expect(validateEvent({ ...base, name: 'nope', props: {} })).toBeNull()
    expect(validateEvent({ ...base, name: 'feature_used', props: { feature: 'bogus' } })).toBeNull()
    expect(validateEvent({ ...base, name: 'feature_used', props: { feature: 'alerts', extra: 1 } })).toBeNull()
  })

  it('denylist catches planted PII', () => {
    const G = 'G' + 'A'.repeat(55)
    for (const props of [
      { feature: 'alerts', email: 'a@b.co' },
      { feature: 'alerts', wallet: G },
      { feature: 'alerts', nested: { pair: 'XLM/USD' } },
      { feature: G },
      { feature: 'a@b.co' },
    ]) {
      expect(containsPii(props)).toBe(true)
      expect(validateEvent({ ...base, name: 'feature_used', props })).toBeNull()
    }
    expect(containsPii({ feature: 'alerts' })).toBe(false)
  })
})
