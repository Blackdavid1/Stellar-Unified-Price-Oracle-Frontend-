/**
 * Public transparency reports (#700).
 *
 * Every number is derived from the same helpers the app already renders —
 * `deriveSourceHealths` (Governance leaderboard), `participationPercent` /
 * `tallyTotal` (proposal cards), and the 0–1 `confidence` on `PriceData` — so
 * the report cannot drift from what users see in-app.
 *
 * Reports are generated on a monthly schedule: the first view in a new period
 * snapshots the report into a dated archive, and past periods stay frozen.
 */

import type { GovernanceProposal, PriceData, SourceName } from '../types'
import { deriveSourceHealths } from './sourceHealth'
import { participationPercent, tallyTotal } from './governance'
import { readJson, writeJson, STORAGE_KEYS } from './storage'

export interface Incident {
  id: string
  date: string
  title: string
  sources: SourceName[]
  postmortemUrl: string
}

/** Published data-quality incidents with postmortems. */
export const INCIDENTS: readonly Incident[] = [
  {
    id: 'INC-2026-001',
    date: '2026-08-14',
    title: 'Band feed stale for 42 minutes after upstream relayer outage',
    sources: ['band'],
    postmortemUrl:
      'https://github.com/Stellar-Unified-Price-Oracle/Stellar-Unified-Price-Oracle-Frontend-/blob/main/docs/incidents/INC-2026-001.md',
  },
]

export interface SourceMetrics {
  source: SourceName
  /** 1 when the source is currently reporting (same rule as the Governance page). */
  uptime: number
  /** Mean 0–1 confidence across pairs the source contributes to, or null. */
  accuracy: number | null
}

export interface TransparencyReport {
  /** Schedule period, `YYYY-MM`. */
  period: string
  generatedAt: number
  sources: SourceMetrics[]
  proposals: { total: number; passed: number; rejected: number; active: number }
  /** Mean participation (0–100) across proposals reporting voting power, or null. */
  meanParticipation: number | null
  totalVotesCast: number
  incidents: Incident[]
}

/** Monthly schedule key for a timestamp (UTC). */
export function reportPeriod(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7)
}

export function buildTransparencyReport(
  prices: readonly PriceData[],
  proposals: readonly GovernanceProposal[],
  now: number = Date.now(),
): TransparencyReport {
  const period = reportPeriod(now)
  const sources = deriveSourceHealths(prices, now).map(({ source, status }) => {
    const covered = prices.filter((p) => p.sources.includes(source))
    const accuracy = covered.length ? covered.reduce((s, p) => s + p.confidence, 0) / covered.length : null
    return { source, uptime: status === 'healthy' ? 1 : 0, accuracy }
  })
  const participations = proposals
    .map((p) => participationPercent(p.tally, p.totalVotingPower))
    .filter((v): v is number => v !== null)
  return {
    period,
    generatedAt: now,
    sources,
    proposals: {
      total: proposals.length,
      passed: proposals.filter((p) => p.status === 'passed' || p.status === 'executed').length,
      rejected: proposals.filter((p) => p.status === 'rejected').length,
      active: proposals.filter((p) => p.status === 'active').length,
    },
    meanParticipation: participations.length ? participations.reduce((a, b) => a + b, 0) / participations.length : null,
    totalVotesCast: proposals.reduce((s, p) => s + tallyTotal(p.tally), 0),
    incidents: INCIDENTS.filter((i) => i.date.slice(0, 7) <= period),
  }
}

export type TransparencyArchive = Record<string, TransparencyReport>

function isArchive(v: unknown): v is TransparencyArchive {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function loadArchive(): TransparencyArchive {
  return readJson(STORAGE_KEYS.transparencyArchive, {}, isArchive)
}

/**
 * Scheduled generation: snapshots `report` into the archive when its period has
 * no entry yet. Returns the (possibly updated) archive.
 */
export function ensureScheduledSnapshot(
  report: TransparencyReport,
  archive: TransparencyArchive = loadArchive(),
): TransparencyArchive {
  if (archive[report.period]) return archive
  const next = { ...archive, [report.period]: report }
  writeJson(STORAGE_KEYS.transparencyArchive, next)
  return next
}
