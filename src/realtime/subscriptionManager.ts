import type { RealtimeSubscription, SubscriptionOptions } from '../types/realtime';

type Listener = (payload: unknown) => void;

interface ManagedSubscription {
  key: string;
  channel: string;
  options: SubscriptionOptions;
  refCount: number;
  listeners: Set<Listener>;
  paused: boolean;
  unsubscribe: (() => void) | null;
}

/**
 * Centralized, ref-counted owner of realtime subscriptions.
 *
 * A given pair/channel is subscribed exactly once; the underlying transport
 * subscription is only torn down when the last consumer releases it. This
 * prevents rapid navigation from leaking subscriptions or dropping one that is
 * still in use.
 *
 * Non-essential subscriptions are paused while the tab is hidden and resumed
 * with a resync on focus. Critical alerting subscriptions (#603) are never
 * paused by visibility changes.
 */
export class SubscriptionManager {
  private subscriptions = new Map<string, ManagedSubscription>();
  private visibilityHandler: (() => void) | null = null;
  private started = false;

  constructor(
    private readonly subscribe: (
      channel: string,
      options: SubscriptionOptions,
      onEvent: Listener,
    ) => RealtimeSubscription,
  ) {}

  /** Begin observing document visibility. Safe to call multiple times. */
  start(): void {
    if (this.started || typeof document === 'undefined') return;
    this.started = true;
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.pauseAll();
      } else {
        this.resumeAll();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /** Stop observing visibility and release every subscription. */
  stop(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
    this.started = false;
    for (const key of Array.from(this.subscriptions.keys())) {
      this.release(key);
    }
  }

  /**
   * Acquire a subscription for a pair/channel. The first consumer opens the
   * underlying subscription; subsequent consumers only bump the ref count.
   * Returns a release function that must be called on teardown.
   */
  acquire(
    key: string,
    channel: string,
    options: SubscriptionOptions,
    listener: Listener,
  ): () => void {
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = {
        key,
        channel,
        options,
        refCount: 0,
        listeners: new Set(),
        paused: false,
        unsubscribe: null,
      };
      this.subscriptions.set(key, entry);
    }

    entry.refCount += 1;
    entry.listeners.add(listener);

    if (!entry.unsubscribe) {
      this.open(entry);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry!.listeners.delete(listener);
      this.release(key);
    };
  }

  /** Number of live underlying subscriptions (used by leak tests). */
  get activeCount(): number {
    return this.subscriptions.size;
  }

  private open(entry: ManagedSubscription): void {
    const onEvent: Listener = (payload) => {
      for (const listener of entry.listeners) listener(payload);
    };
    const sub = this.subscribe(entry.channel, entry.options, onEvent);
    entry.unsubscribe = () => sub.unsubscribe();
    entry.paused = false;
  }

  private release(key: string): void {
    const entry = this.subscriptions.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    this.subscriptions.delete(key);
  }

  private pauseAll(): void {
    for (const entry of this.subscriptions.values()) {
      if (entry.options.critical) continue;
      if (entry.paused) continue;
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      entry.paused = true;
    }
  }

  private resumeAll(): void {
    for (const entry of this.subscriptions.values()) {
      if (!entry.paused) continue;
      entry.paused = false;
      this.open(entry);
      // Resync after a visibility gap so missed events are reconciled.
      entry.options.onResync?.();
    }
  }
}
