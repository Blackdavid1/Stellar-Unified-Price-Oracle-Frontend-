/**
 * @file DisputePanel — Dispute & challenge process (#695).
 *
 * Displays all price disputes with their status, evidence link, and resolution
 * notes. Supports submitting a new dispute inline. All dispute data comes
 * verbatim from the API; the client never infers outcomes.
 */
import { memo, useState, type FormEvent, type ReactElement } from 'react'
import { useSwr } from '../hooks/useSwr'
import { fetchDisputes, submitDispute } from '../api/rest'
import type { PriceDispute } from '../types'
import { DISPUTE_STATUS_LABELS, DISPUTE_OUTCOME_LABELS, isDisputeOpen, orderDisputes } from '../utils/governance'
import { sanitizeUrl } from '../utils/htmlSanitizer'

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLOURS: Record<PriceDispute['status'], string> = {
  open: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  under_review: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  resolved: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  dismissed: 'bg-gray-500/20 text-gray-400 border-gray-600',
}

// ── Single dispute card ───────────────────────────────────────────────────────

interface DisputeCardProps {
  dispute: PriceDispute
}

const DisputeCard = memo(function DisputeCard({ dispute }: DisputeCardProps): ReactElement {
  const createdDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(dispute.createdAt),
  )
  const resolvedDate = dispute.resolvedAt
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(dispute.resolvedAt),
      )
    : null

  const safeEvidenceUrl = dispute.evidenceUrl ? sanitizeUrl(dispute.evidenceUrl) : null

  return (
    <li
      className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3"
      aria-label={`Dispute ${dispute.id} for ${dispute.assetPair}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-mono text-gray-400">{dispute.id}</span>
            <span className="font-medium text-gray-100">{dispute.assetPair}</span>
          </div>
          <span className="text-xs text-gray-500">{createdDate} — by {dispute.challenger}</span>
        </div>
        <span
          className={`text-xs font-medium px-2 py-1 rounded-full border ${STATUS_COLOURS[dispute.status]}`}
          aria-label={`Status: ${DISPUTE_STATUS_LABELS[dispute.status]}`}
        >
          {DISPUTE_STATUS_LABELS[dispute.status]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div className="flex flex-col gap-0.5">
          <dt className="text-gray-500">Disputed price</dt>
          <dd className="font-mono text-gray-100">{dispute.disputedPrice.toLocaleString('en-US', { maximumFractionDigits: 7 })}</dd>
        </div>
        {dispute.flaggedSources.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-gray-500">Flagged sources</dt>
            <dd className="text-gray-100">{dispute.flaggedSources.join(', ')}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-gray-500">Reason</p>
        <p className="text-sm text-gray-300">{dispute.reason}</p>
      </div>

      {safeEvidenceUrl && (
        <a
          href={safeEvidenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
        >
          View attached evidence ↗
        </a>
      )}

      {dispute.outcome !== null && (
        <div className="border-t border-gray-800 pt-3 flex flex-col gap-1">
          <p className="text-xs text-gray-500">
            Outcome:{' '}
            <span className="font-semibold text-gray-200">{DISPUTE_OUTCOME_LABELS[dispute.outcome]}</span>
            {resolvedDate && <> · {resolvedDate}</>}
          </p>
          {dispute.resolutionNotes && (
            <p className="text-xs text-gray-400 italic">{dispute.resolutionNotes}</p>
          )}
        </div>
      )}
    </li>
  )
})

// ── Submit form ───────────────────────────────────────────────────────────────

interface SubmitFormProps {
  onSubmitted: () => void
}

function SubmitDisputeForm({ onSubmitted }: SubmitFormProps): ReactElement {
  const [assetPair, setAssetPair] = useState('')
  const [disputedPrice, setDisputedPrice] = useState('')
  const [priceTimestamp, setPriceTimestamp] = useState('')
  const [reason, setReason] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [flaggedSources, setFlaggedSources] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitError(null)

    const price = parseFloat(disputedPrice)
    const timestamp = parseInt(priceTimestamp, 10)

    if (!assetPair.trim() || !Number.isFinite(price) || !Number.isFinite(timestamp) || !reason.trim()) {
      setSubmitError('Asset pair, price, timestamp (ms), and reason are required.')
      return
    }

    const sources = flaggedSources
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const rawUrl = evidenceUrl.trim() || null
    const safeUrl = rawUrl ? sanitizeUrl(rawUrl) : null
    if (rawUrl && !safeUrl) {
      setSubmitError('Evidence URL uses an unsafe protocol. Only https:// links are accepted.')
      return
    }

    try {
      setSubmitting(true)
      await submitDispute({
        assetPair: assetPair.trim(),
        disputedPrice: price,
        priceTimestamp: timestamp,
        reason: reason.trim(),
        evidenceUrl: safeUrl,
        flaggedSources: sources,
      })
      onSubmitted()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const fieldClass =
    'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-gray-900 border border-gray-700 rounded-2xl p-5 flex flex-col gap-4"
      aria-label="Submit a price dispute"
      noValidate
    >
      <h3 className="text-sm font-semibold text-gray-100">Submit a dispute</h3>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="dispute-pair" className="text-xs text-gray-400">
            Asset pair <span aria-hidden="true">*</span>
          </label>
          <input
            id="dispute-pair"
            type="text"
            value={assetPair}
            onChange={(e) => setAssetPair(e.target.value)}
            placeholder="e.g. BTC/USD"
            className={fieldClass}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dispute-price" className="text-xs text-gray-400">
            Disputed price <span aria-hidden="true">*</span>
          </label>
          <input
            id="dispute-price"
            type="number"
            step="any"
            value={disputedPrice}
            onChange={(e) => setDisputedPrice(e.target.value)}
            placeholder="e.g. 42000.5"
            className={fieldClass}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dispute-timestamp" className="text-xs text-gray-400">
            Price timestamp (Unix ms) <span aria-hidden="true">*</span>
          </label>
          <input
            id="dispute-timestamp"
            type="number"
            value={priceTimestamp}
            onChange={(e) => setPriceTimestamp(e.target.value)}
            placeholder="e.g. 1700000000000"
            className={fieldClass}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dispute-sources" className="text-xs text-gray-400">
            Flagged sources (comma-separated)
          </label>
          <input
            id="dispute-sources"
            type="text"
            value={flaggedSources}
            onChange={(e) => setFlaggedSources(e.target.value)}
            placeholder="e.g. chainlink, band"
            className={fieldClass}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="dispute-reason" className="text-xs text-gray-400">
          Reason <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="dispute-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Describe the discrepancy observed and why the price is contested."
          className={`${fieldClass} resize-y`}
          required
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="dispute-evidence" className="text-xs text-gray-400">
          Evidence URL (optional — https:// only)
        </label>
        <input
          id="dispute-evidence"
          type="url"
          value={evidenceUrl}
          onChange={(e) => setEvidenceUrl(e.target.value)}
          placeholder="https://…"
          className={fieldClass}
        />
      </div>

      {submitError && (
        <p role="alert" className="text-xs text-red-400">
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="self-start min-h-[44px] px-5 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        {submitting ? 'Submitting…' : 'Submit dispute'}
      </button>
    </form>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function DisputePanel(): ReactElement {
  const { data, loading, error, refetch } = useSwr(
    'governance/disputes',
    (signal) => fetchDisputes(signal),
    { refreshInterval: 60_000, staleTime: 30_000 },
  )

  const [showForm, setShowForm] = useState(false)

  function handleSubmitted() {
    setShowForm(false)
    refetch()
  }

  const ordered = data ? orderDisputes(data) : null
  const openCount = data ? data.filter(isDisputeOpen).length : 0

  return (
    <section aria-labelledby="disputes-heading" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 id="disputes-heading" className="text-lg font-semibold text-gray-100">
          Price disputes
        </h2>
        <div className="flex items-center gap-3">
          {!loading && error === null && data && (
            <span className="text-xs text-gray-500">
              {openCount > 0 ? `${openCount} open` : 'No open disputes'}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            aria-expanded={showForm}
            className="min-h-[36px] px-3 py-1.5 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors border border-gray-700"
          >
            {showForm ? 'Cancel' : 'Raise a dispute'}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        When sources disagree and the aggregate price is contested, a formal dispute can be filed here with evidence
        attached. All disputes leave a permanent on-platform record. Resolutions are written by reviewers — the client
        never infers an outcome.
      </p>

      {showForm && <SubmitDisputeForm onSubmitted={handleSubmitted} />}

      {loading && !data && (
        <p className="text-sm text-gray-500 py-6 text-center" role="status">
          Loading disputes…
        </p>
      )}

      {!loading && error !== null && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 flex flex-col items-start gap-3">
          <p className="text-sm text-red-300">Could not load price disputes.</p>
          <button
            type="button"
            onClick={refetch}
            className="min-h-[44px] px-4 py-2 text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && error === null && (!ordered || ordered.length === 0) && (
        <p className="text-sm text-gray-500 py-6 text-center">No disputes on record.</p>
      )}

      {ordered && ordered.length > 0 && (
        <ul className="flex flex-col gap-3 list-none p-0">
          {ordered.map((dispute) => (
            <DisputeCard key={dispute.id} dispute={dispute} />
          ))}
        </ul>
      )}
    </section>
  )
}
