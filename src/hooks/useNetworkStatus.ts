import { useState, useEffect, useCallback, useRef } from 'react'

export interface UseNetworkStatusResult {
  /** Whether the browser currently has a network connection */
  isOnline: boolean
  /** Timestamp of the last status change, or null if no change has occurred */
  lastChanged: number | null
  /**
   * Monotonic counter incremented each time the network transitions to online.
   * Consumers can use this as a fast-recovery probe trigger: when it changes,
   * a reconnect should be attempted immediately rather than waiting out the
   * current backoff window.
   */
  onlineEpoch: number
}

/**
 * Tracks the browser's online/offline status via `navigator.onLine` and the
 * `online`/`offline` window events.
 *
 * Returns `isOnline`, a `lastChanged` timestamp, and an `onlineEpoch` counter
 * so consumers can react to connectivity transitions and trigger fast-recovery
 * reconnects when the network signals it is back online.
 */
export function useNetworkStatus(): UseNetworkStatusResult {
  const [isOnline, setIsOnline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine,
  )
  const [lastChanged, setLastChanged] = useState<number | null>(null)
  const [onlineEpoch, setOnlineEpoch] = useState(0)
  const onlineRef = useRef(isOnline)

  const goOnline = useCallback(() => {
    setIsOnline(true)
    setLastChanged(Date.now())
    // Only bump the epoch on an actual offline -> online transition so a
    // duplicate `online` event does not trigger a redundant fast-recovery
    // probe (and therefore a duplicate reconnect/alert).
    if (!onlineRef.current) {
      onlineRef.current = true
      setOnlineEpoch((n) => n + 1)
    }
  }, [])

  const goOffline = useCallback(() => {
    setIsOnline(false)
    setLastChanged(Date.now())
    onlineRef.current = false
  }, [])

  useEffect(() => {
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [goOnline, goOffline])

  return { isOnline, lastChanged, onlineEpoch }
}
