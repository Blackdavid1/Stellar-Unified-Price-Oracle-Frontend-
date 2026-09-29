/**
 * Vercel serverless function that collects Content-Security-Policy violation
 * reports sent via the `report-to`/`report-uri` directives in vercel.json, and
 * the browser's Reporting API (`Reporting-Endpoints` header).
 *
 * This repo has no persistent backend, so reports are simply logged to the
 * function's structured logs (visible in the Vercel dashboard / `vercel logs`)
 * rather than stored. The primary, always-available violation surface is the
 * client-side capture in src/utils/cspReporting.ts, which does not depend on
 * this endpoint. Wire `console.log` output here into a real log sink (e.g.
 * forward to the existing error-reporting pipeline) if longer-term retention
 * is needed later.
 *
 * Triage pipeline (issue #687):
 * - Each report is classified by source (extension, injected script, or
 *   first-party bug) via a rule set so benign noise can be filtered out.
 * - Reports are deduplicated within a short window and volume is rate-limited
 *   per client so a report flood cannot become a DoS.
 * - First-party violations are emitted with `firstParty: true` and a
 *   `gate: 'fail'` marker so the log sink / CI can fail the appropriate gate.
 * See docs/csp-triage-runbook.md for the review workflow.
 *
 * Third-party origin governance (issue #689):
 * - Every external origin that appears in a violation is cross-checked against
 *   the central allow-list (src/security/externalOrigins.ts). A blocked origin
 *   that is NOT in the registry is flagged with `unregisteredOrigin: true` so
 *   the log sink / CI can surface drift between code, CSP, and the allow-list.
 * - Registered origins carry their owner + review date so triage can route the
 *   report to the responsible party and confirm the entry is still in review.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { findExternalOrigin } from '../src/security/externalOrigins'

type ViolationSource = 'extension' | 'injected-script' | 'first-party'

interface ClassifiedReport {
  source: ViolationSource
  firstParty: boolean
  gate: 'fail' | 'review'
  reason: string
  origin?: string
  originRegistered?: boolean
  originOwner?: string
  originReviewDue?: string
  unregisteredOrigin?: boolean
}

// --- Rate limiting -------------------------------------------------------
// Keep a small in-memory window per warm function instance. This is a coarse
// guard (not a distributed limiter) but is enough to stop a single client from
// flooding the endpoint and turning report collection into a DoS vector.
const RATE_WINDOW_MS = 60_000
const RATE_MAX_PER_WINDOW = 60
const DEDUPE_WINDOW_MS = 5 * 60_000

const rateBuckets = new Map<string, number[]>()
const seenReports = new Map<string, number>()

function clientKey(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  const ip = Array.isArray(fwd) ? fwd[0] : fwd
  return (ip || 'unknown').split(',')[0].trim()
}

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    rateBuckets.set(key, hits)
    return true
  }
  hits.push(now)
  rateBuckets.set(key, hits)
  return false
}

function dedupeKey(report: Record<string, unknown>): string {
  const body = (report['csp-report'] || report.body || report) as Record<string, unknown>
  return [
    body['document-uri'] || body.documentURL || '',
    body['violated-directive'] || body.effectiveDirective || '',
    body['blocked-uri'] || body.blockedURL || '',
    body['source-file'] || body.sourceFile || '',
  ].join('|')
}

function isDuplicate(key: string): boolean {
  const now = Date.now()
  const last = seenReports.get(key)
  if (last && now - last < DEDUPE_WINDOW_MS) return true
  seenReports.set(key, now)
  // Opportunistic cleanup so the map cannot grow unbounded.
  if (seenReports.size > 1000) {
    for (const [k, t] of seenReports) {
      if (now - t >= DEDUPE_WINDOW_MS) seenReports.delete(k)
    }
  }
  return false
}

// --- Classification rule set --------------------------------------------
const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-extension:', 'ms-browser-extension:']
const INJECTED_HINTS = ['eval', 'data:', 'blob:', 'javascript:']

/**
 * Extract the origin (scheme://host) from a blocked/source URI so it can be
 * matched against the central external-origin allow-list. Returns null for
 * opaque schemes (data:, blob:, eval) that have no governable origin.
 */
function extractOrigin(uri: string): string | null {
  if (!uri) return null
  try {
    const url = new URL(uri)
    if (!url.protocol.startsWith('http')) return null
    return url.origin
  } catch {
    return null
  }
}

function classify(report: Record<string, unknown>): ClassifiedReport {
  const body = (report['csp-report'] || report.body || report) as Record<string, unknown>
  const blocked = String(body['blocked-uri'] || body.blockedURL || '')
  const source = String(body['source-file'] || body.sourceFile || '')
  const directive = String(body['violated-directive'] || body.effectiveDirective || '')

  if (EXTENSION_SCHEMES.some((s) => blocked.startsWith(s) || source.startsWith(s))) {
    return { source: 'extension', firstParty: false, gate: 'review', reason: 'browser-extension origin' }
  }

  if (INJECTED_HINTS.some((h) => blocked.startsWith(h)) || directive.includes('script-src')) {
    return { source: 'injected-script', firstParty: false, gate: 'review', reason: 'inline/injected script blocked' }
  }

  return { source: 'first-party', firstParty: true, gate: 'fail', reason: 'first-party resource blocked by CSP' }
}

/**
 * Cross-check a violation's origin against the central allow-list (#689).
 * A blocked http(s) origin that is not registered is flagged so the log sink
 * can detect drift between code, CSP, and the registry.
 */
function governOrigin(report: Record<string, unknown>): Partial<ClassifiedReport> {
  const body = (report['csp-report'] || report.body || report) as Record<string, unknown>
  const blocked = String(body['blocked-uri'] || body.blockedURL || '')
  const source = String(body['source-file'] || body.sourceFile || '')
  const origin = extractOrigin(blocked) || extractOrigin(source)
  if (!origin) return {}

  const entry = findExternalOrigin(origin)
  if (!entry) {
    return { origin, originRegistered: false, unregisteredOrigin: true }
  }
  return {
    origin,
    originRegistered: true,
    originOwner: entry.owner,
    originReviewDue: entry.reviewDate,
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return
  }

  const key = clientKey(req)
  if (isRateLimited(key)) {
    // Drop silently with 429 so a flood cannot amplify into log volume.
    res.statusCode = 429
    res.end()
    return
  }

  let body = ''
  for await (const chunk of req) body += chunk

  try {
    const parsed = JSON.parse(body)
    // Support both the legacy `csp-report` shape and the newer Reporting API
    // array-of-reports shape.
    const reports = Array.isArray(parsed) ? parsed : [parsed]
    for (const report of reports) {
      const dkey = dedupeKey(report)
      if (isDuplicate(dkey)) continue
      const classification = classify(report)
      const governance = governOrigin(report)
      console.log(
        JSON.stringify({
          type: 'csp-violation',
          receivedAt: new Date().toISOString(),
          ...classification,
          ...governance,
          report,
        }),
      )
    }
  } catch {
    console.log(JSON.stringify({ type: 'csp-violation', receivedAt: new Date().toISOString(), raw: body.slice(0, 2000) }))
  }

  res.statusCode = 204
  res.end()
}
