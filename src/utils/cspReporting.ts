/**
 * Captures Content-Security-Policy violations directly in the browser via the
 * `securitypolicyviolation` event, which fires for both enforced and
 * Report-Only policies regardless of whether a server-side report endpoint is
 * configured. This is the primary source of truth for the in-app
 * `CspViolationsPanel` dashboard.
 *
 * Violations are also mirrored through `console.warn` so they show up in the
 * existing console aggregator (src/utils/consoleAggregator.ts) for anyone
 * already watching that panel.
 *
 * Triage pipeline: each report is classified by source (extension, injected
 * script, first-party bug), deduplicated, and rate-limited before it enters the
 * reviewable buffer. First-party violations are surfaced as gate failures via
 * `getFirstPartyViolations()` / `hasFirstPartyViolations()` so a regression
 * cannot hide among benign noise. See docs/csp-triage-runbook.md.
 */

export type CspViolationSource = 'extension' | 'injected-script' | 'first-party' | 'unknown'

export interface CspViolation {
  directive: string
  blockedUri: string
  documentUri: string
  disposition: 'enforce' | 'report'
  sourceFile?: string
  lineNumber?: number
  timestamp: number
  /** Classified origin of the violation, derived from the rule set below. */
  source: CspViolationSource
  /** Stable key used to deduplicate repeated reports of the same violation. */
  fingerprint: string
  /** How many times this exact violation has been observed. */
  count: number
}

const MAX_ENTRIES = 200
/** Hard cap on reports accepted per rolling window to avoid a report flood DoS. */
const RATE_LIMIT_MAX = 50
const RATE_LIMIT_WINDOW_MS = 10_000

const violations: CspViolation[] = []
const directiveCounts = new Map<string, number>()
const byFingerprint = new Map<string, CspViolation>()
let windowStart = 0
let windowCount = 0
let droppedInWindow = 0

type Listener = (violations: CspViolation[]) => void
const listeners = new Set<Listener>()

let installed = false

function notify() {
  listeners.forEach((l) => l([...violations]))
}

/**
 * Rule set mapping a blocked URI / source file to a violation source. Order
 * matters: extension schemes are checked before generic injected-script
 * heuristics, and same-origin resources fall through to first-party.
 */
const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-extension:', 'ms-browser-extension:']
const EXTENSION_HOSTS = ['chrome-extension://', 'moz-extension://', 'safari-extension://']
const INJECTED_URI_PATTERNS = [
  /^data:/i,
  /^blob:/i,
  /^eval$/i,
  /^inline$/i,
  /^about:blank$/i,
  /^javascript:/i,
]
const INJECTED_SOURCE_PATTERNS = [/inject/i, /userscript/i, /tampermonkey/i, /greasemonkey/i]

export function classifyViolation(blockedUri: string, sourceFile?: string): CspViolationSource {
  const uri = blockedUri || ''
  const src = sourceFile || ''

  if (EXTENSION_SCHEMES.some((s) => uri.startsWith(s)) || EXTENSION_HOSTS.some((h) => uri.includes(h))) {
    return 'extension'
  }
  if (INJECTED_URI_PATTERNS.some((re) => re.test(uri))) return 'injected-script'
  if (INJECTED_SOURCE_PATTERNS.some((re) => re.test(src))) return 'injected-script'

  // Same-origin / relative resources are our own code — a real regression.
  if (uri === '' || uri === '(inline)' || uri.startsWith('/') || uri.startsWith(location?.origin ?? '\u0000')) {
    return 'first-party'
  }
  return 'unknown'
}

function fingerprintOf(v: Pick<CspViolation, 'directive' | 'blockedUri' | 'sourceFile' | 'lineNumber'>): string {
  return [v.directive, v.blockedUri, v.sourceFile ?? '', v.lineNumber ?? ''].join('|')
}

/**
 * Rolling-window rate limiter. Returns true when the report may be recorded,
 * false when the window is saturated (the report is dropped, not queued).
 */
function allowReport(now: number): boolean {
  if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
    windowStart = now
    windowCount = 0
    droppedInWindow = 0
  }
  if (windowCount >= RATE_LIMIT_MAX) {
    droppedInWindow += 1
    return false
  }
  windowCount += 1
  return true
}

function record(v: CspViolation) {
  const existing = byFingerprint.get(v.fingerprint)
  if (existing) {
    // Dedupe: bump the count and refresh the timestamp in place.
    existing.count += 1
    existing.timestamp = v.timestamp
    directiveCounts.set(existing.directive, (directiveCounts.get(existing.directive) ?? 0) + 1)
    notify()
    return
  }

  violations.unshift(v)
  if (violations.length > MAX_ENTRIES) {
    const evicted = violations.pop()
    if (evicted) byFingerprint.delete(evicted.fingerprint)
  }
  byFingerprint.set(v.fingerprint, v)
  directiveCounts.set(v.directive, (directiveCounts.get(v.directive) ?? 0) + 1)

  console.warn(
    `[CSP ${v.disposition === 'report' ? 'report-only' : 'blocked'}] ${v.directive} — blocked ${v.blockedUri} (${v.source})`,
  )
  notify()
}

/** Best-effort POST to a same-origin collector; never throws, never blocks. */
function reportToServer(event: SecurityPolicyViolationEvent) {
  try {
    const endpoint = '/api/csp-report'
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': event.documentURI,
        'violated-directive': event.violatedDirective,
        'effective-directive': event.effectiveDirective,
        'blocked-uri': event.blockedURI,
        disposition: event.disposition,
        'source-file': event.sourceFile,
        'line-number': event.lineNumber,
      },
    })
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/csp-report' }))
    } else {
      void fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/csp-report' } })
    }
  } catch {
    // Reporting must never affect the app; swallow any failure.
  }
}

export function installCspReporting(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  document.addEventListener('securitypolicyviolation', (event) => {
    const now = Date.now()
    if (!allowReport(now)) return

    const blockedUri = event.blockedURI || '(inline)'
    const sourceFile = event.sourceFile || undefined
    const directive = event.violatedDirective || event.effectiveDirective || 'unknown'
    const lineNumber = event.lineNumber || undefined

    record({
      directive,
      blockedUri,
      documentUri: event.documentURI,
      disposition: (event.disposition as 'enforce' | 'report') || 'enforce',
      sourceFile,
      lineNumber,
      timestamp: now,
      source: classifyViolation(blockedUri, sourceFile),
      fingerprint: fingerprintOf({ directive, blockedUri, sourceFile, lineNumber }),
      count: 1,
    })
    reportToServer(event)
  })
}

export function getCspViolations(): CspViolation[] {
  return [...violations]
}

/**
 * First-party violations only — the subset that should fail a build/regression
 * gate. Extensions and injected scripts are noise and are excluded.
 */
export function getFirstPartyViolations(): CspViolation[] {
  return violations.filter((v) => v.source === 'first-party')
}

/** Gate helper: true when any first-party violation has been recorded. */
export function hasFirstPartyViolations(): boolean {
  return violations.some((v) => v.source === 'first-party')
}

/** Directive → violation count, sorted descending, for the "top violating directives" view. */
export function getTopDirectives(): Array<{ directive: string; count: number }> {
  return Array.from(directiveCounts.entries())
    .map(([directive, count]) => ({ directive, count }))
    .sort((a, b) => b.count - a.count)
}

/** Number of reports dropped by the rate limiter in the current window. */
export function getDroppedReportCount(): number {
  return droppedInWindow
}

export function clearCspViolations(): void {
  violations.length = 0
  directiveCounts.clear()
  byFingerprint.clear()
  windowStart = 0
  windowCount = 0
  droppedInWindow = 0
  notify()
}

export function subscribeCspViolations(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function exportCspViolations(): string {
  return JSON.stringify(violations, null, 2)
}
