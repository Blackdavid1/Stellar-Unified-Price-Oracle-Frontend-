import { useEffect, useId, useState, type ReactElement } from 'react'
import { buildShareLink, decodeWorkspace, type ShareLinkResult, type Workspace } from '../utils/workspaceShare'

interface WorkspaceShareDialogProps {
  /** Current dashboard workspace to share. */
  workspace: Workspace
  /** Base URL of the dashboard route used for inline links. */
  baseUrl: string
  /** Payload from an incoming `?ws=` link; opens the import preview. */
  incomingPayload?: string | null
  onApply: (workspace: Workspace) => void
  onClose: () => void
}

/** Share / import a dashboard workspace, with a preview before applying (#702). */
export function WorkspaceShareDialog({
  workspace,
  baseUrl,
  incomingPayload,
  onApply,
  onClose,
}: WorkspaceShareDialogProps): ReactElement {
  const titleId = useId()
  const [tab, setTab] = useState<'share' | 'import'>(incomingPayload ? 'import' : 'share')
  const [link, setLink] = useState<ShareLinkResult | null>(null)
  const [input, setInput] = useState(incomingPayload ?? '')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void buildShareLink(workspace, baseUrl).then((r) => live && setLink(r))
    return () => {
      live = false
    }
  }, [workspace, baseUrl])

  // Accept either a full link or a bare payload.
  const payload = (() => {
    try {
      return new URL(input).searchParams.get('ws') ?? input
    } catch {
      return input
    }
  })()
  const decoded = payload ? decodeWorkspace(payload) : null
  const shareText = link ? (link.kind === 'too-large' ? link.payload : link.url) : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 p-5 flex flex-col gap-4 text-sm">
        <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
          Shareable workspace
        </h2>
        <div role="tablist" className="flex gap-2">
          {(['share', 'import'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded border capitalize ${tab === t ? 'bg-cyan-600 text-white' : ''}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'share' ? (
          <div className="flex flex-col gap-2">
            <p className="text-gray-600 dark:text-gray-400">
              Includes pairs, filters, columns, and chart view. No alerts, wallet, or personal data is included.
            </p>
            {link?.kind === 'too-large' && (
              <p role="status" className="text-amber-600">
                This workspace is too large for a link and no short-link service is available. Copy the payload below
                and paste it into Import instead.
              </p>
            )}
            <textarea
              readOnly
              rows={4}
              value={shareText}
              aria-label="Share link"
              className="rounded border px-2 py-1 font-mono text-xs dark:bg-gray-800"
            />
            <button
              type="button"
              onClick={copy}
              disabled={!link}
              className="self-start px-3 py-1.5 rounded bg-cyan-600 text-white disabled:opacity-50"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              Paste a workspace link or payload
              <textarea
                rows={3}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="rounded border px-2 py-1 font-mono text-xs dark:bg-gray-800"
              />
            </label>
            {decoded && !decoded.ok && (
              <p role="alert" className="text-red-600">
                {decoded.error}
              </p>
            )}
            {decoded?.ok && (
              <div className="rounded border border-gray-200 dark:border-gray-800 p-3" aria-label="Workspace preview">
                <p className="font-medium mb-1">Preview</p>
                <ul className="list-disc ps-5">
                  <li>
                    {decoded.workspace.pairs.length} pairs
                    {decoded.workspace.pairs.length
                      ? `: ${decoded.workspace.pairs.slice(0, 8).join(', ')}${decoded.workspace.pairs.length > 8 ? '…' : ''}`
                      : ''}
                  </li>
                  <li>Search: {decoded.workspace.search || '—'}</li>
                  <li>Sources: {decoded.workspace.filters.sources.join(', ') || 'all'}</li>
                  <li>
                    Confidence {decoded.workspace.filters.minConf}–{decoded.workspace.filters.maxConf}%
                  </li>
                  <li>{decoded.workspace.columns.length} export columns</li>
                  <li>View: {decoded.workspace.chart.view}</li>
                </ul>
                <button
                  type="button"
                  onClick={() => onApply(decoded.workspace)}
                  className="mt-3 px-3 py-1.5 rounded bg-cyan-600 text-white"
                >
                  Apply workspace
                </button>
              </div>
            )}
          </div>
        )}
        <button type="button" onClick={onClose} className="self-end px-3 py-1.5 rounded border">
          Close
        </button>
      </div>
    </div>
  )
}
