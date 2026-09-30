/**
 * Visibility-aware subscription lifecycle management.
 *
 * Provides ref-counted subscription ownership (a pair is subscribed once and
 * released only when the last consumer leaves) and pauses non-essential
 * subscriptions while the tab is hidden, resuming with a resync on focus.
 *
 * Critical alerting subscriptions (#603) are never paused by visibility
 * changes.
 */

export type SubscriptionKey = string;

export interface SubscriptionHandle {
  /** Release this consumer's hold on the subscription. */
  release(): void;
}

export interface SubscriptionOptions {
  /**
   * Essential subscriptions (e.g. critical alerting, #603) are immune to
   * visibility-based pausing and stay live while the tab is hidden.
   */
  essential?: boolean;
  /** Invoked when the subscription should (re)connect. */
  subscribe?: () => void;
  /** Invoked when the subscription should be torn down. */
  unsubscribe?: () => void;
  /** Invoked on focus to resync state after a visibility pause. */
  resync?: () => void;
}

interface Entry {
  refCount: number;
  essential: boolean;
  subscribe?: () => void;
  unsubscribe?: () => void;
  resync?: () => void;
  /** Whether the underlying subscription is currently live. */
  active: boolean;
}

/**
 * Centralized, ref-counted subscription registry with a single owner per pair.
 */
export class SubscriptionManager {
  private readonly entries = new Map<SubscriptionKey, Entry>();
  private hidden = false;
  private listening = false;

  /**
   * Acquire a subscription for `key`. The first consumer triggers the
   * underlying subscribe; subsequent consumers only bump the ref count.
   */
  acquire(key: SubscriptionKey, options: SubscriptionOptions = {}): SubscriptionHandle {
    this.ensureVisibilityListener();

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        refCount: 0,
        essential: options.essential ?? false,
        subscribe: options.subscribe,
        unsubscribe: options.unsubscribe,
        resync: options.resync,
        active: false,
      };
      this.entries.set(key, entry);
    } else {
      // Keep the strongest guarantees across consumers of the same pair.
      entry.essential = entry.essential || (options.essential ?? false);
      entry.subscribe = entry.subscribe ?? options.subscribe;
      entry.unsubscribe = entry.unsubscribe ?? options.unsubscribe;
      entry.resync = entry.resync ?? options.resync;
    }

    entry.refCount += 1;

    // Subscribe once, and only when it should be live right now.
    if (!entry.active && this.shouldBeActive(entry)) {
      entry.active = true;
      entry.subscribe?.();
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.release(key);
      },
    };
  }

  /** Release one consumer's hold; tears down when the last consumer leaves. */
  private release(key: SubscriptionKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    if (entry.active) {
      entry.active = false;
      entry.unsubscribe?.();
    }
    this.entries.delete(key);
  }

  /** Number of live subscriptions (for leak assertions). */
  get activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.active) count += 1;
    }
    return count;
  }

  /** Number of tracked pairs, including paused ones (for leak assertions). */
  get size(): number {
    return this.entries.size;
  }

  /** Tear down every subscription. Used on route change / teardown. */
  teardownAll(): void {
    for (const [key, entry] of this.entries) {
      if (entry.active) {
        entry.active = false;
        entry.unsubscribe?.();
      }
      this.entries.delete(key);
    }
  }

  private shouldBeActive(entry: Entry): boolean {
    // Essential subscriptions are never paused by visibility.
    return entry.essential || !this.hidden;
  }

  private ensureVisibilityListener(): void {
    if (this.listening) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    this.listening = true;
    this.hidden = document.visibilityState === 'hidden';
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly onVisibilityChange = (): void => {
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;

    for (const entry of this.entries.values()) {
      if (hidden) {
        // Pause non-essential subscriptions while the tab is hidden.
        if (!entry.essential && entry.active) {
          entry.active = false;
          entry.unsubscribe?.();
        }
      } else {
        // Resume and resync on focus.
        if (!entry.active && this.shouldBeActive(entry)) {
          entry.active = true;
          entry.subscribe?.();
          entry.resync?.();
        }
      }
    }
  };
}

/** Shared manager instance used across the app. */
export const subscriptionManager = new SubscriptionManager();
