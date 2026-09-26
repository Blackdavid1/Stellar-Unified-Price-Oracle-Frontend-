/**
 * First-party, privacy-preserving telemetry. Events are validated against the
 * versioned schema, gated on explicit consent (default: none), and stored in a
 * bounded local buffer. Optionally flushed to `config.analyticsEndpoint`.
 *
 * Independent of utils/analytics.ts and any other consent store; see
 * docs/ANALYTICS.md for how these could converge.
 */
import { EVENT_PROPS, TELEMETRY_SCHEMA_VERSION, validateEvent, type TelemetryEvent, type TelemetryEventName } from './schema'
import type { z } from 'zod'

const CONSENT_KEY = 'spo.telemetry.consent.v1'
const BUFFER_KEY = 'spo.telemetry.buffer.v1'
const INSTALL_KEY = 'spo.telemetry.install.v1'
export const MAX_BUFFER = 1000
const HOUR = 3_600_000

export type Consent = 'granted' | 'denied' | 'unset'

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function getConsent(): Consent {
  const v = ls()?.getItem(CONSENT_KEY)
  return v === 'granted' || v === 'denied' ? v : 'unset'
}

export function setConsent(c: Exclude<Consent, 'unset'>): void {
  ls()?.setItem(CONSENT_KEY, c)
  if (c === 'denied') clearTelemetry()
}

export function clearTelemetry(): void {
  ls()?.removeItem(BUFFER_KEY)
}

function installId(): string {
  const s = ls()
  let id = s?.getItem(INSTALL_KEY)
  if (!id) {
    id = crypto.randomUUID()
    s?.setItem(INSTALL_KEY, id)
  }
  return id
}

export function readBuffer(): TelemetryEvent[] {
  try {
    const raw = JSON.parse(ls()?.getItem(BUFFER_KEY) ?? '[]') as unknown[]
    return raw.map(validateEvent).filter((e): e is TelemetryEvent => e !== null)
  } catch {
    return []
  }
}

/**
 * Records an event. Returns true only if consent is granted and the event
 * passed validation; otherwise nothing is stored or sent.
 */
export function track<N extends TelemetryEventName>(
  name: N,
  props: z.input<(typeof EVENT_PROPS)[N]>,
  now = Date.now(),
): boolean {
  if (getConsent() !== 'granted') return false
  const event = validateEvent({
    v: TELEMETRY_SCHEMA_VERSION,
    name,
    ts: Math.floor(now / HOUR) * HOUR,
    installId: installId(),
    props,
  })
  if (!event) return false
  try {
    const buf = [...readBuffer(), event].slice(-MAX_BUFFER)
    ls()?.setItem(BUFFER_KEY, JSON.stringify(buf))
  } catch {
    return false
  }
  return true
}
