import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { readJson, writeJson, STORAGE_KEYS } from '../utils/storage'
import { useReducedMotion } from '../hooks/useReducedMotion'

export const TOUR_STEPS = [
  { title: 'Search pairs', body: 'Use the search box (or press / ) to filter asset pairs by name.' },
  { title: 'Build watchlists', body: 'Star pairs and group them into watchlists to keep the ones you track in view.' },
  { title: 'Set alerts', body: 'Use the bell on any price card to get notified when a threshold is crossed.' },
  {
    title: 'Export data',
    body: 'Export prices as CSV, JSON, or PDF from the toolbar, and choose the columns you need.',
  },
] as const

interface TourState {
  step: number
  done: boolean
}

const isTourState = (v: unknown): v is TourState =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TourState).step === 'number' &&
  typeof (v as TourState).done === 'boolean'

export function readTourState(): TourState {
  return readJson(STORAGE_KEYS.onboardingTour, { step: 0, done: false }, isTourState)
}

/** Re-open the tour after it was completed (e.g. from an empty state). */
export function resetTour(): void {
  writeJson(STORAGE_KEYS.onboardingTour, { step: 0, done: false })
}

interface OnboardingTourProps {
  /** Force open (e.g. "Take the tour" button). */
  forceOpen?: boolean
  onClose?: () => void
}

/**
 * First-run, step-based tour (#701). Progress persists via `storage.ts`; once
 * finished or skipped it never shows again unless explicitly reopened. It is a
 * plain dialog with text steps, so screen-reader and keyboard users get the
 * same content, and animation is dropped under reduced motion.
 */
export function OnboardingTour({ forceOpen = false, onClose }: OnboardingTourProps): ReactElement | null {
  const [state, setState] = useState<TourState>(readTourState)
  const reducedMotion = useReducedMotion()
  const titleId = useId()
  const nextRef = useRef<HTMLButtonElement>(null)
  const open = forceOpen || !state.done

  useEffect(() => {
    if (open) nextRef.current?.focus()
  }, [open, state.step])

  if (!open) return null

  const step = Math.min(state.step, TOUR_STEPS.length - 1)
  const persist = (next: TourState) => {
    setState(next)
    writeJson(STORAGE_KEYS.onboardingTour, next)
  }
  const finish = () => {
    persist({ step, done: true })
    onClose?.()
  }
  const last = step === TOUR_STEPS.length - 1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-body`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish()
        if (e.key === 'ArrowRight' && !last) persist({ step: step + 1, done: false })
        if (e.key === 'ArrowLeft' && step > 0) persist({ step: step - 1, done: false })
      }}
      className={`fixed bottom-4 end-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-cyan-500/40 bg-white dark:bg-gray-900 p-4 shadow-xl text-sm ${reducedMotion ? '' : 'animate-in fade-in slide-in-from-bottom-2 duration-300'}`}
    >
      <p className="text-xs text-gray-500" aria-live="polite">
        Step {step + 1} of {TOUR_STEPS.length}
      </p>
      <h2 id={titleId} className="font-semibold text-gray-900 dark:text-white mt-1">
        {TOUR_STEPS[step].title}
      </h2>
      <p id={`${titleId}-body`} className="text-gray-600 dark:text-gray-400 mt-1">
        {TOUR_STEPS[step].body}
      </p>
      <div className="flex justify-between items-center mt-4 gap-2">
        <button type="button" onClick={finish} className="text-gray-500 underline underline-offset-2">
          Skip tour
        </button>
        <div className="flex gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={() => persist({ step: step - 1, done: false })}
              className="px-3 py-1 rounded border"
            >
              Back
            </button>
          )}
          <button
            ref={nextRef}
            type="button"
            onClick={() => (last ? finish() : persist({ step: step + 1, done: false }))}
            className="px-3 py-1 rounded bg-cyan-600 text-white"
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
