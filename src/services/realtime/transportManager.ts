/**
 * Multi-transport orchestration for realtime subscriptions.
 *
 * Ranks available transports by health and capability (WS preferred), fails
 * over to the next transport on repeated failure, and recovers upward once a
 * preferred transport becomes healthy again. Consumers use a single logical
 * subscription API and are unaware of the underlying transport switch.
 */

export type TransportKind = 'ws' | 'sse' | 'polling';

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export interface TransportHealth {
  kind: TransportKind;
  status: TransportStatus;
  /** Consecutive failures since the last successful open. */
  consecutiveFailures: number;
  /** Timestamp (ms) of the last successful open, if any. */
  lastHealthyAt?: number;
}

export interface TransportMessage<T = unknown> {
  data: T;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Capability rank; higher is preferred. WS > SSE > polling. */
  readonly priority: number;
  connect(): Promise<void>;
  close(): void;
  onMessage(handler: (message: TransportMessage) => void): () => void;
  onStatusChange(handler: (status: TransportStatus) => void): () => void;
}

export interface TransportManagerOptions {
  /** Number of consecutive failures before failing over to the next transport. */
  failureThreshold?: number;
  /** Interval (ms) between health probes of higher-priority transports. */
  recoveryProbeIntervalMs?: number;
  /** Called whenever the active transport changes (downgrade or recovery). */
  onTransportChange?: (change: TransportChange) => void;
}

export interface TransportChange {
  from: TransportKind | null;
  to: TransportKind;
  direction: 'downgrade' | 'recovery' | 'initial';
}

export interface Subscription<T = unknown> {
  unsubscribe(): void;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_PROBE_INTERVAL_MS = 15_000;

/**
 * Orchestrates a ranked set of transports behind a single subscription API.
 */
export class TransportManager {
  private readonly transports: Transport[];
  private readonly failureThreshold: number;
  private readonly recoveryProbeIntervalMs: number;
  private readonly onTransportChange?: (change: TransportChange) => void;

  private activeIndex = -1;
  private health = new Map<TransportKind, TransportHealth>();
  private messageHandlers = new Set<(message: TransportMessage) => void>();
  private statusHandlers = new Set<(status: TransportStatus) => void>();
  private unsubscribers: Array<() => void> = [];
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(transports: Transport[], options: TransportManagerOptions = {}) {
    if (transports.length === 0) {
      throw new Error('TransportManager requires at least one transport');
    }
    // Rank by capability, preferring WS, then SSE, then polling.
    this.transports = [...transports].sort((a, b) => b.priority - a.priority);
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.recoveryProbeIntervalMs =
      options.recoveryProbeIntervalMs ?? DEFAULT_RECOVERY_PROBE_INTERVAL_MS;
    this.onTransportChange = options.onTransportChange;

    for (const transport of this.transports) {
      this.health.set(transport.kind, {
        kind: transport.kind,
        status: 'idle',
        consecutiveFailures: 0,
      });
    }
  }

  /** The currently active transport kind, or null before start. */
  get activeTransport(): TransportKind | null {
    return this.activeIndex >= 0 ? this.transports[this.activeIndex].kind : null;
  }

  /** Snapshot of health for all known transports. */
  getHealth(): TransportHealth[] {
    return this.transports.map((t) => ({ ...this.health.get(t.kind)! }));
  }

  /**
   * Single logical subscription API. Consumers receive messages regardless of
   * which transport is currently active.
   */
  subscribe<T = unknown>(handler: (message: TransportMessage<T>) => void): Subscription<T> {
    const wrapped = handler as (message: TransportMessage) => void;
    this.messageHandlers.add(wrapped);
    return {
      unsubscribe: () => {
        this.messageHandlers.delete(wrapped);
      },
    };
  }

  /** Observe status changes of the active transport. */
  onStatusChange(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Start orchestration, selecting the best available transport. */
  async start(): Promise<void> {
    if (this.disposed) return;
    await this.activate(0, 'initial');
    this.startRecoveryProbe();
  }

  /** Stop orchestration and close the active transport. */
  dispose(): void {
    this.disposed = true;
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.detachActive();
    this.messageHandlers.clear();
    this.statusHandlers.clear();
  }

  private async activate(index: number, direction: TransportChange['direction']): Promise<void> {
    if (this.disposed) return;
    const previous = this.activeTransport;
    this.detachActive();
    this.activeIndex = index;
    const transport = this.transports[index];

    this.unsubscribers.push(
      transport.onMessage((message) => {
        for (const handler of this.messageHandlers) handler(message);
      }),
    );
    this.unsubscribers.push(
      transport.onStatusChange((status) => {
        this.updateHealth(transport.kind, status);
        for (const handler of this.statusHandlers) handler(status);
        if (status === 'failed') this.handleFailure(transport.kind);
      }),
    );

    try {
      await transport.connect();
      this.updateHealth(transport.kind, 'open');
    } catch {
      this.updateHealth(transport.kind, 'failed');
      this.handleFailure(transport.kind);
      return;
    }

    if (previous !== transport.kind) {
      this.onTransportChange?.({ from: previous, to: transport.kind, direction });
    }
  }

  private detachActive(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.activeIndex >= 0) {
      this.transports[this.activeIndex].close();
    }
  }

  private updateHealth(kind: TransportKind, status: TransportStatus): void {
    const current = this.health.get(kind);
    if (!current) return;
    if (status === 'open') {
      current.status = 'open';
      current.consecutiveFailures = 0;
      current.lastHealthyAt = Date.now();
    } else if (status === 'failed') {
      current.status = 'failed';
      current.consecutiveFailures += 1;
    } else {
      current.status = status;
    }
  }

  private handleFailure(kind: TransportKind): void {
    const health = this.health.get(kind);
    if (!health || health.consecutiveFailures < this.failureThreshold) return;
    if (this.activeTransport !== kind) return;
    // Fail over to the next lower-priority transport.
    const nextIndex = this.activeIndex + 1;
    if (nextIndex < this.transports.length) {
      void this.activate(nextIndex, 'downgrade');
    }
  }

  private startRecoveryProbe(): void {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = setInterval(() => {
      void this.probeRecovery();
    }, this.recoveryProbeIntervalMs);
  }

  /** Attempt to recover upward to a higher-priority transport once healthy. */
  private async probeRecovery(): Promise<void> {
    if (this.disposed || this.activeIndex <= 0) return;
    const preferred = this.transports[this.activeIndex - 1];
    const health = this.health.get(preferred.kind);
    if (!health) return;

    try {
      await preferred.connect();
      this.updateHealth(preferred.kind, 'open');
      await this.activate(this.activeIndex - 1, 'recovery');
    } catch {
      this.updateHealth(preferred.kind, 'failed');
    }
  }
}
