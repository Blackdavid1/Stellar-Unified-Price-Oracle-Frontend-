/**
 * Virtual clock (#609) used to make realtime timing deterministic in tests and
 * in the deterministic session replay feature (#670).
 *
 * The clock exposes a monotonic `now()` in milliseconds and lets callers
 * advance time explicitly instead of relying on wall-clock timers. Replay
 * drives the clock so recorded frames are delivered at their original offsets.
 */

export type VirtualClockListener = (now: number) => void;

export interface VirtualClock {
  /** Current virtual time in milliseconds. */
  now(): number;
  /** Advance the clock by `deltaMs` and flush due timers. */
  advance(deltaMs: number): void;
  /** Schedule `fn` to run after `delayMs` of virtual time. */
  setTimeout(fn: () => void, delayMs: number): number;
  /** Cancel a timer previously scheduled with `setTimeout`. */
  clearTimeout(handle: number): void;
  /** Subscribe to clock advances; returns an unsubscribe function. */
  subscribe(listener: VirtualClockListener): () => void;
}

interface ScheduledTimer {
  handle: number;
  dueAt: number;
  fn: () => void;
}

/**
 * Create a virtual clock starting at `startMs` (defaults to 0).
 *
 * Timers are ordered by due time and, for equal due times, by insertion order
 * so replay is fully deterministic regardless of host scheduling.
 */
export function createVirtualClock(startMs = 0): VirtualClock {
  let current = startMs;
  let nextHandle = 1;
  const timers = new Map<number, ScheduledTimer>();
  const listeners = new Set<VirtualClockListener>();

  const flushDue = (): void => {
    // Repeatedly pick the earliest due timer until none remain due.
    for (;;) {
      let next: ScheduledTimer | undefined;
      for (const timer of timers.values()) {
        if (timer.dueAt > current) continue;
        if (
          next === undefined ||
          timer.dueAt < next.dueAt ||
          (timer.dueAt === next.dueAt && timer.handle < next.handle)
        ) {
          next = timer;
        }
      }
      if (next === undefined) return;
      timers.delete(next.handle);
      next.fn();
    }
  };

  return {
    now: () => current,
    advance(deltaMs: number) {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        throw new RangeError('virtual clock cannot advance by a negative amount');
      }
      current += deltaMs;
      flushDue();
      for (const listener of listeners) listener(current);
    },
    setTimeout(fn: () => void, delayMs: number) {
      const handle = nextHandle++;
      const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      timers.set(handle, { handle, dueAt: current + delay, fn });
      return handle;
    },
    clearTimeout(handle: number) {
      timers.delete(handle);
    },
    subscribe(listener: VirtualClockListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
