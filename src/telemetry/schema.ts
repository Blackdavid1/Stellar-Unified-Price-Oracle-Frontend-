import { z } from 'zod'

export const TELEMETRY_SCHEMA_VERSION = 1

/** Every event, its allow-listed properties. Nothing outside this table is emitted. */
export const EVENT_PROPS = {
  dashboard_loaded: z.object({ success: z.boolean(), durationMs: z.number().int().min(0).max(600_000).optional() }).strict(),
  feature_used: z.object({ feature: z.enum(['alerts', 'export', 'compare', 'onchain', 'search', 'chart', 'webhooks', 'governance']) }).strict(),
  route_viewed: z.object({ route: z.enum(['dashboard', 'price_detail', 'api_docs', 'webhooks', 'governance', 'other']) }).strict(),
  error_shown: z.object({ kind: z.enum(['network', 'validation', 'rpc', 'unknown']) }).strict(),
} as const

export type TelemetryEventName = keyof typeof EVENT_PROPS
export const EVENT_NAMES = Object.keys(EVENT_PROPS) as TelemetryEventName[]

export const envelopeSchema = z
  .object({
    v: z.literal(TELEMETRY_SCHEMA_VERSION),
    name: z.enum(EVENT_NAMES as [TelemetryEventName, ...TelemetryEventName[]]),
    /** Epoch ms truncated to the hour to limit fingerprinting. */
    ts: z.number().int().nonnegative(),
    /** Random per-install id; never derived from user data. */
    installId: z.string().regex(/^[a-f0-9-]{8,64}$/),
    props: z.record(z.string(), z.unknown()),
  })
  .strict()

export type TelemetryEvent = z.infer<typeof envelopeSchema>

/** Keys (case-insensitive substring) that must never appear, even nested. */
export const PII_DENYLIST = [
  'email', 'address', 'wallet', 'publickey', 'secret', 'token', 'password', 'name', 'ip',
  'phone', 'pair', 'asset', 'symbol', 'userid', 'account', 'query', 'url',
]

export function containsPii(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    // Stellar public keys / emails in values
    return typeof value === 'string' && (/\bG[A-Z2-7]{55}\b/.test(value) || /\S+@\S+\.\S+/.test(value))
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => PII_DENYLIST.some((d) => k.toLowerCase().includes(d)) || containsPii(v),
  )
}

/** Validates an event; returns null (drops) on any violation. */
export function validateEvent(input: unknown): TelemetryEvent | null {
  const env = envelopeSchema.safeParse(input)
  if (!env.success) return null
  if (containsPii(env.data.props)) return null
  const props = EVENT_PROPS[env.data.name].safeParse(env.data.props)
  if (!props.success) return null
  return { ...env.data, props: props.data }
}
