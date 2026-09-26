/**
 * Soroban RPC resilience: ordered provider list, health scoring, failover,
 * retry with backoff, and the shared circuit breaker (`api/circuitBreaker.ts`).
 *
 * Providers come from `VITE_SOROBAN_RPC_URLS` (comma separated, preferred first).
 * The pool is transport-agnostic: callers pass `fn(url)` and the pool picks the
 * provider, records the outcome and fails over on error/timeout/429.
 */
import { circuitBreaker, CircuitOpenError } from '../api/circuitBreaker'

export interface ProviderHealth {
  url: string
  /** Exponentially weighted moving average of latency (ms). */
  latencyMs: number
  /** EWMA of failure outcomes, 0..1. */
  errorRate: number
  /** Highest ledger sequence this provider has reported. */
  lastLedger: number | null
  /** Ledgers behind the best known tip. */
  lag: number
  /** 0..1, higher is healthier. */
  score: number
  circuit: 'closed' | 'open' | 'half-open'
  requests: number
  failures: number
}

export interface RpcPoolOptions {
  /** Per-attempt timeout in ms. */
  timeoutMs: number
  /** Retries per provider before moving on (0 = one attempt). */
  retriesPerProvider: number
  baseBackoffMs: number
  /** Providers scoring below this are skipped while a better one exists. */
  minScore: number
  /** A provider more than this many ledgers behind the best tip is stale. */
  maxLedgerLag: number
  ewmaAlpha: number
  sleep: (ms: number) => Promise<void>
}

export const DEFAULT_RPC_OPTIONS: RpcPoolOptions = {
  timeoutMs: 8_000,
  retriesPerProvider: 1,
  baseBackoffMs: 250,
  minScore: 0.4,
  maxLedgerLag: 5,
  ewmaAlpha: 0.3,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

export class RpcOutageError extends Error {
  readonly causes: unknown[]
  constructor(causes: unknown[]) {
    super(`All Soroban RPC providers failed (${causes.length} attempt(s)).`)
    this.name = 'RpcOutageError'
    this.causes = causes
  }
}

export class RpcTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`RPC ${url} timed out after ${ms}ms`)
    this.name = 'RpcTimeoutError'
  }
}

interface Stat {
  latencyMs: number
  errorRate: number
  lastLedger: number | null
  requests: number
  failures: number
}

const circuitKey = (url: string) => `rpc:${url}`

export function parseProviderList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export class RpcProviderPool {
  private stats = new Map<string, Stat>()
  private opts: RpcPoolOptions

  constructor(readonly urls: string[], opts: Partial<RpcPoolOptions> = {}) {
    this.opts = { ...DEFAULT_RPC_OPTIONS, ...opts }
    for (const u of urls) {
      this.stats.set(u, { latencyMs: 0, errorRate: 0, lastLedger: null, requests: 0, failures: 0 })
    }
  }

  /** Highest ledger observed across providers, or null. */
  bestTip(): number | null {
    let best: number | null = null
    for (const s of this.stats.values()) {
      if (s.lastLedger !== null && (best === null || s.lastLedger > best)) best = s.lastLedger
    }
    return best
  }

  /** Records the ledger a provider reported (used for staleness detection). */
  recordLedger(url: string, ledger: number): void {
    const s = this.stats.get(url)
    if (s && (s.lastLedger === null || ledger > s.lastLedger)) s.lastLedger = ledger
  }

  isStale(url: string): boolean {
    const tip = this.bestTip()
    const s = this.stats.get(url)
    if (tip === null || !s || s.lastLedger === null) return false
    return tip - s.lastLedger > this.opts.maxLedgerLag
  }

  private score(s: Stat, stale: boolean): number {
    const latencyPenalty = Math.min(s.latencyMs / (this.opts.timeoutMs * 2), 0.5)
    const raw = 1 - s.errorRate - latencyPenalty
    return Math.max(0, Math.min(1, stale ? raw * 0.25 : raw))
  }

  health(): ProviderHealth[] {
    const tip = this.bestTip()
    return this.urls.map((url) => {
      const s = this.stats.get(url)!
      const stale = this.isStale(url)
      return {
        url,
        latencyMs: Math.round(s.latencyMs),
        errorRate: s.errorRate,
        lastLedger: s.lastLedger,
        lag: tip !== null && s.lastLedger !== null ? tip - s.lastLedger : 0,
        score: this.score(s, stale),
        circuit: circuitBreaker.getState(circuitKey(url)),
        requests: s.requests,
        failures: s.failures,
      }
    })
  }

  /**
   * Providers in attempt order: preferred order among healthy ones (so the
   * preferred provider is reinstated once its score recovers), then the
   * degraded ones best-score-first as a last resort. Stale tips are excluded
   * from the healthy set.
   */
  candidates(): string[] {
    const h = this.health()
    const healthy = h.filter((p) => p.circuit !== 'open' && p.score >= this.opts.minScore && !this.isStale(p.url))
    const rest = h
      .filter((p) => !healthy.includes(p) && p.circuit !== 'open')
      .sort((a, b) => b.score - a.score)
    return [...healthy, ...rest].map((p) => p.url)
  }

  private observe(url: string, ok: boolean, ms: number): void {
    const s = this.stats.get(url)!
    const a = this.opts.ewmaAlpha
    s.requests += 1
    if (!ok) s.failures += 1
    s.errorRate = s.errorRate * (1 - a) + (ok ? 0 : 1) * a
    s.latencyMs = s.requests === 1 ? ms : s.latencyMs * (1 - a) + ms * a
    if (ok) circuitBreaker.recordSuccess(circuitKey(url))
    else circuitBreaker.recordFailure(circuitKey(url))
  }

  /**
   * Runs `fn(url)` against providers until one succeeds. Timeouts, 429s and
   * any thrown error fail over to the next provider; total outage throws
   * {@link RpcOutageError}.
   */
  async call<T>(fn: (url: string, signal: AbortSignal) => Promise<T>): Promise<{ value: T; url: string }> {
    const causes: unknown[] = []
    for (const url of this.candidates()) {
      if (!circuitBreaker.canRequest(circuitKey(url))) {
        causes.push(new CircuitOpenError(circuitKey(url)))
        continue
      }
      for (let attempt = 0; attempt <= this.opts.retriesPerProvider; attempt++) {
        const started = Date.now()
        const ctrl = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const value = await Promise.race([
            fn(url, ctrl.signal),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => {
                ctrl.abort()
                rej(new RpcTimeoutError(url, this.opts.timeoutMs))
              }, this.opts.timeoutMs)
            }),
          ])
          this.observe(url, true, Date.now() - started)
          return { value, url }
        } catch (err) {
          this.observe(url, false, Date.now() - started)
          causes.push(err)
          // Rate-limited: back off less aggressively on the same provider is
          // pointless; move on immediately.
          if (isRateLimit(err) || attempt === this.opts.retriesPerProvider) break
          await this.opts.sleep(this.opts.baseBackoffMs * 2 ** attempt)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
    }
    throw new RpcOutageError(causes)
  }
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number } | null
  return e?.status === 429 || e?.statusCode === 429
}

let shared: RpcProviderPool | null = null

/** Process-wide pool built from `VITE_SOROBAN_RPC_URLS`. */
export function getRpcPool(): RpcProviderPool {
  if (!shared) {
    const urls = parseProviderList(import.meta.env.VITE_SOROBAN_RPC_URLS as string | undefined)
    shared = new RpcProviderPool(urls)
  }
  return shared
}

export function setRpcPoolForTests(pool: RpcProviderPool | null): void {
  shared = pool
}
