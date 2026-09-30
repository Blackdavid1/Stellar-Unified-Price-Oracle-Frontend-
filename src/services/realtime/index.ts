/**
 * Realtime transport orchestration.
 *
 * Ranks the available transports (WebSocket, SSE, polling) by health and
 * capability, preferring WebSocket. Fails over to the next transport on
 * repeated failure and recovers upward once the preferred transport is
 * healthy again. Consumers subscribe through a single logical API and are
 * unaware of the underlying transport switch.
 */

export type TransportKind = 'ws' | 'sse' | 'polling';

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export interface RealtimeMessage {
  type: string;
  payload?: unknown;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Whether this transport is usable in the current environment. */
  isAvailable(): boolean;
  connect(): void;
  disconnect(): void;
  send(message: RealtimeMessage): void;
  onMessage(handler: (message: RealtimeMessage) => void): () => void;
  onStatus(handler: (status: TransportStatus) => void): () => void;
}

export interface TransportManagerOptions {
  /** Ordered preference, highest first. Defaults to ws > sse > polling. */
  preference?: TransportKind[];
  /** Consecutive failures before failing over to the next transport. */
  failureThreshold?: number;
  /** Interval (ms) between health probes for upward recovery. */
  recoveryIntervalMs?: number;
}

export interface TransportState {
  active: TransportKind | null;
  /** True when the active transport is not the most preferred available one. */
  downgraded: boolean;
  status: TransportStatus;
}

const DEFAULT_PREFERENCE: TransportKind[] = ['ws', 'sse', 'polling'];
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_INTERVAL_MS = 15_000;

export class TransportManager {
  private readonly preference: TransportKind[];
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private readonly transports = new Map<TransportKind, Transport>();

  private active: Transport | null = null;
  private activeStatus: TransportStatus = 'idle';
  private consecutiveFailures = 0;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  private readonly messageHandlers = new Set<(message: RealtimeMessage) => void>();
  private readonly stateHandlers = new Set<(state: TransportState) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(transports: Transport[], options: TransportManagerOptions = {}) {
    this.preference = options.preference ?? DEFAULT_PREFERENCE;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;

    for (const transport of transports) {
      this.transports.set(transport.kind, transport);
    }
  }

  /** Ranked list of transports that are currently available, best first. */
  private rankedAvailable(): Transport[] {
    return this.preference
      .map((kind) => this.transports.get(kind))
      .filter((transport): transport is Transport => Boolean(transport) && transport!.isAvailable());
  }

  /** The most preferred available transport. */
  private preferred(): Transport | null {
    return this.rankedAvailable()[0] ?? null;
  }

  start(): void {
    this.activate(this.preferred());
    this.startRecoveryProbe();
  }

  stop(): void {
    this.stopRecoveryProbe();
    this.detachActive();
    this.active = null;
    this.activeStatus = 'idle';
    this.emitState();
  }

  getState(): TransportState {
    const preferred = this.preferred();
    return {
      active: this.active?.kind ?? null,
      downgraded: Boolean(preferred && this.active && preferred.kind !== this.active.kind),
      status: this.activeStatus,
    };
  }

  /** Single logical subscription API, independent of the active transport. */
  subscribe(handler: (message: RealtimeMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.getState());
    return () => this.stateHandlers.delete(handler);
  }

  send(message: RealtimeMessage): void {
    this.active?.send(message);
  }

  private activate(transport: Transport | null): void {
    if (transport === this.active) {
      return;
    }
    this.detachActive();
    this.active = transport;
    this.consecutiveFailures = 0;

    if (!transport) {
      this.activeStatus = 'failed';
      this.emitState();
      return;
    }

    this.unsubscribers.push(
      transport.onMessage((message) => this.emitMessage(message)),
      transport.onStatus((status) => this.handleStatus(status)),
    );
    this.activeStatus = 'connecting';
    transport.connect();
    this.emitState();
  }

  private detachActive(): void {
    if (!this.active) {
      return;
    }
    this.active.disconnect();
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  private handleStatus(status: TransportStatus): void {
    this.activeStatus = status;

    if (status === 'failed' || status === 'closed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.failover();
        return;
      }
    } else if (status === 'open') {
      this.consecutiveFailures = 0;
    }

    this.emitState();
  }

  /** Move to the next best available transport after repeated failure. */
  private failover(): void {
    const available = this.rankedAvailable();
    const currentIndex = this.active ? available.indexOf(this.active) : -1;
    const next = available[currentIndex + 1] ?? null;
    this.activate(next);
  }

  private startRecoveryProbe(): void {
    if (this.recoveryTimer !== null) {
      return;
    }
    this.recoveryTimer = setInterval(() => this.tryRecover(), this.recoveryIntervalMs);
  }

  private stopRecoveryProbe(): void {
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** Recover upward to the preferred transport once it is healthy again. */
  private tryRecover(): void {
    const preferred = this.preferred();
    if (preferred && preferred !== this.active) {
      this.activate(preferred);
    }
  }

  private emitMessage(message: RealtimeMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private emitState(): void {
    const state = this.getState();
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}
