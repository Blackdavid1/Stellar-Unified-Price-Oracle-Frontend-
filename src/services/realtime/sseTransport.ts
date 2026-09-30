/**
 * Realtime transport layer.
 *
 * Provides the individual transports (WebSocket, SSE, polling) plus a
 * `TransportManager` that orchestrates them: it ranks transports by health and
 * capability (WS preferred), fails over on repeated failure, and recovers
 * upward once the preferred transport is healthy again. Consumers subscribe
 * through a single logical API and are unaware of the underlying switch.
 */

export type TransportKind = 'ws' | 'sse' | 'polling';

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface TransportMessage {
  data: string;
  transport: TransportKind;
}

export interface Transport {
  readonly kind: TransportKind;
  connect(): void;
  close(): void;
  send?(data: string): void;
  onMessage(handler: (message: TransportMessage) => void): void;
  onStatus(handler: (status: TransportStatus) => void): void;
}

export interface TransportManagerOptions {
  /** Ordered preference, most preferred first. Defaults to ws, sse, polling. */
  preference?: TransportKind[];
  /** Consecutive failures before a transport is considered unhealthy. */
  failureThreshold?: number;
  /** Interval (ms) between health probes of higher-ranked transports. */
  recoveryIntervalMs?: number;
  /** Factory used to build a transport for a given kind. */
  createTransport: (kind: TransportKind) => Transport;
}

export interface TransportState {
  active: TransportKind | null;
  status: TransportStatus;
  /** True when the active transport is not the most preferred one. */
  downgraded: boolean;
}

const DEFAULT_PREFERENCE: TransportKind[] = ['ws', 'sse', 'polling'];

/**
 * Ranks transports by health and capability and switches between them.
 * WS is preferred; on repeated failure it fails over to the next transport and
 * recovers upward once a higher-ranked transport is healthy again.
 */
export class TransportManager {
  private readonly preference: TransportKind[];
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private readonly createTransport: (kind: TransportKind) => Transport;

  private transport: Transport | null = null;
  private activeIndex = -1;
  private failures = 0;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  private readonly messageHandlers = new Set<(message: TransportMessage) => void>();
  private readonly stateHandlers = new Set<(state: TransportState) => void>();

  constructor(options: TransportManagerOptions) {
    this.preference = options.preference ?? DEFAULT_PREFERENCE;
    this.failureThreshold = options.failureThreshold ?? 2;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 15000;
    this.createTransport = options.createTransport;
  }

  /** Single logical subscription API: consumers never see the transport switch. */
  subscribe(handler: (message: TransportMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  getState(): TransportState {
    const active = this.activeIndex >= 0 ? this.preference[this.activeIndex] : null;
    return {
      active,
      status: this.transport ? 'open' : 'idle',
      downgraded: this.activeIndex > 0,
    };
  }

  start(): void {
    this.activate(0);
  }

  stop(): void {
    this.clearRecoveryTimer();
    this.transport?.close();
    this.transport = null;
    this.activeIndex = -1;
    this.failures = 0;
    this.emitState();
  }

  send(data: string): void {
    this.transport?.send?.(data);
  }

  private activate(index: number): void {
    if (index >= this.preference.length) {
      // Total failure: no transport is available.
      this.transport = null;
      this.activeIndex = -1;
      this.emitState();
      return;
    }

    this.transport?.close();
    this.failures = 0;
    this.activeIndex = index;

    const kind = this.preference[index];
    const transport = this.createTransport(kind);
    this.transport = transport;

    transport.onMessage((message) => {
      for (const handler of this.messageHandlers) handler(message);
    });
    transport.onStatus((status) => {
      if (status === 'open') {
        this.failures = 0;
        this.emitState();
        this.scheduleRecovery();
      } else if (status === 'error' || status === 'closed') {
        this.handleFailure();
      }
    });

    transport.connect();
    this.emitState();
  }

  private handleFailure(): void {
    this.failures += 1;
    if (this.failures < this.failureThreshold) return;
    // Repeated failure: fail over to the next transport.
    this.activate(this.activeIndex + 1);
  }

  private scheduleRecovery(): void {
    this.clearRecoveryTimer();
    if (this.activeIndex <= 0) return;
    this.recoveryTimer = setInterval(() => this.probePreferred(), this.recoveryIntervalMs);
  }

  private probePreferred(): void {
    if (this.activeIndex <= 0) {
      this.clearRecoveryTimer();
      return;
    }
    const preferredIndex = this.activeIndex - 1;
    const kind = this.preference[preferredIndex];
    const probe = this.createTransport(kind);
    let settled = false;

    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      probe.close();
      if (healthy) {
        // Recover upward to the preferred transport.
        this.activate(preferredIndex);
      }
    };

    probe.onStatus((status) => {
      if (status === 'open') finish(true);
      else if (status === 'error' || status === 'closed') finish(false);
    });
    probe.connect();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private emitState(): void {
    const state = this.getState();
    for (const handler of this.stateHandlers) handler(state);
  }
}

/**
 * Server-Sent Events transport. Kept as a concrete transport so the manager can
 * rank and switch it alongside WebSocket and polling.
 */
export class SseTransport implements Transport {
  readonly kind: TransportKind = 'sse';

  private source: EventSource | null = null;
  private messageHandler: ((message: TransportMessage) => void) | null = null;
  private statusHandler: ((status: TransportStatus) => void) | null = null;

  constructor(private readonly url: string) {}

  connect(): void {
    this.statusHandler?.('connecting');
    try {
      this.source = new EventSource(this.url);
      this.source.onopen = () => this.statusHandler?.('open');
      this.source.onmessage = (event) =>
        this.messageHandler?.({ data: event.data, transport: this.kind });
      this.source.onerror = () => this.statusHandler?.('error');
    } catch {
      this.statusHandler?.('error');
    }
  }

  close(): void {
    this.source?.close();
    this.source = null;
    this.statusHandler?.('closed');
  }

  onMessage(handler: (message: TransportMessage) => void): void {
    this.messageHandler = handler;
  }

  onStatus(handler: (status: TransportStatus) => void): void {
    this.statusHandler = handler;
  }
}
