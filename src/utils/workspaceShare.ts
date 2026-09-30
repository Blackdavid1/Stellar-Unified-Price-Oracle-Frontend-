/**
 * Shareable workspaces (#702).
 *
 * A workspace (pairs, filters, columns, chart config) is encoded as versioned
 * JSON → base64url. Decoding is untrusted input and always goes through the Zod
 * schema. The schema is an allow-list, so secrets, wallet addresses, alert
 * channels, or any other user-specific data can never ride along.
 */

import { z } from 'zod'
import { config } from '../config'
import { EXPORT_COLUMN_KEYS, type ExportColumnKey } from './exportColumns'

export const WORKSPACE_VERSION = 1
/** Links longer than this are unreliable across chat apps/browsers. */
export const MAX_INLINE_PAYLOAD = 1800
export const WORKSPACE_PARAM = 'ws'

const pair = z.string().regex(/^[A-Z0-9]{1,12}[/-][A-Z0-9]{1,12}$/)

export const workspaceSchema = z.object({
  v: z.literal(WORKSPACE_VERSION),
  pairs: z.array(pair).max(200),
  search: z.string().max(100),
  filters: z.object({
    sources: z.array(z.string().max(20)).max(10),
    minConf: z.number().min(0).max(100),
    maxConf: z.number().min(0).max(100),
    minPrice: z.string().max(30),
    maxPrice: z.string().max(30),
    updatedWithin: z.string().max(10),
    sort: z.string().max(30),
    sortDir: z.enum(['asc', 'desc']),
  }),
  columns: z.array(z.enum(EXPORT_COLUMN_KEYS as unknown as [ExportColumnKey, ...ExportColumnKey[]])).max(50),
  chart: z.object({ view: z.enum(['card', 'table']) }),
})

export type Workspace = z.infer<typeof workspaceSchema>

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(payload: string): string {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** Encodes a workspace. Re-validates so only allow-listed fields are emitted. */
export function encodeWorkspace(ws: Workspace): string {
  return toBase64Url(JSON.stringify(workspaceSchema.parse(ws)))
}

export type DecodeResult = { ok: true; workspace: Workspace } | { ok: false; error: string }

export function decodeWorkspace(payload: string): DecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(fromBase64Url(payload.trim()))
  } catch {
    return { ok: false, error: 'Link is not a valid workspace payload.' }
  }
  if (typeof raw === 'object' && raw !== null && 'v' in raw && raw.v !== WORKSPACE_VERSION) {
    return { ok: false, error: `Unsupported workspace version ${String(raw.v)}.` }
  }
  const parsed = workspaceSchema.safeParse(raw)
  return parsed.success
    ? { ok: true, workspace: parsed.data }
    : { ok: false, error: 'Workspace failed schema validation.' }
}

export type ShareLinkResult =
  { kind: 'inline'; url: string } | { kind: 'short'; url: string } | { kind: 'too-large'; payload: string }

/**
 * Builds a share link. Oversized payloads fall back to a backend short link
 * when one is available, and otherwise return the raw payload so the user can
 * still copy it into the import box.
 */
export async function buildShareLink(ws: Workspace, baseUrl: string): Promise<ShareLinkResult> {
  const payload = encodeWorkspace(ws)
  if (payload.length <= MAX_INLINE_PAYLOAD) return { kind: 'inline', url: `${baseUrl}?${WORKSPACE_PARAM}=${payload}` }
  try {
    const res = await fetch(`${config.apiUrl}/workspaces/short-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    })
    if (res.ok) {
      const body = z.object({ url: z.string().url() }).safeParse(await res.json())
      if (body.success && /^https?:/.test(body.data.url)) return { kind: 'short', url: body.data.url }
    }
  } catch {
    /* no backend — degrade below */
  }
  return { kind: 'too-large', payload }
}
