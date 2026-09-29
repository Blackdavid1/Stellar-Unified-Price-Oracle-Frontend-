/**
 * WebSocket leader election with cross-tab fan-out and ordering guarantees.
 *
 * A single tab (the leader) owns the socket. Followers receive fan-out
 * messages over a BroadcastChannel. Every fan-out message carries a
 * monotonically increasing sequence number so followers can apply updates
 * in order and detect gaps. On activation (or after a detected gap) a
 * follower requests a full state resync from the leader.
 */

export type LeaderRole = 'leader' | 'follower';

export interface FanOutMessage<T = unknown> {
  type: 'fanout';
  /** Monotonic sequence number assigned by the leader. */
  seq: number;
  /** Leader epoch; changes on handover so followers can detect a new leader. */
  epoch: number;
  payload: T;
}

export interface ResyncRequestMessage {
  type: 'resync-request';
  /** Last sequence number the follower successfully applied. */
  lastSeq: number;
  epoch: number;
}

export interface ResyncResponseMessage<T = unknown> {
  type: 'resync-response';
  epoch: number;
  seq: number;
  /** Full state snapshot for the follower to adopt. */
  state: T;
}

export interface LeaderClaimMessage {
  type: 'leader-claim';
  epoch: number;
}

export type ChannelMessage<T = unknown> =
  | FanOutMessage<T>
  | ResyncRequestMessage
  | ResyncResponseMessage<T>
  | LeaderClaimMessage;

export interface LeaderElectionOptions<T = unknown> {
  channelName: string;
  /** Called when this tab becomes the leader and should open the socket. */
  onBecomeLeader: () => void;
  /** Called when this tab loses leadership and should close the socket. */
  onLoseLeadership: () => void;
  /** Apply an ordered fan-out payload from the leader. */
  onFanOut: (payload: T) => void;
  /** Produce a full state snapshot for resync responses. */
  getState: () => T;
  /** Adopt a full state snapshot received during resync. */
  setState: (state: T) => void;
}

interface LeaderElectionState<T> {
  role: LeaderRole;
  epoch: number;
  /** Next sequence number the leader will assign. */
  nextSeq: number;
  /** Last sequence number applied by a follower. */
  lastAppliedSeq: number;
  /** Pending fan-out messages buffered while awaiting a resync. */
  pending: FanOutMessage<T>[];
  resyncing: boolean;
}

export class WsLeaderElection<T = unknown> {
  private readonly options: LeaderElectionOptions<T>;
  private channel: BroadcastChannel | null = null;
  private state: LeaderElectionState<T>;
  private disposed = false;

  constructor(options: LeaderElectionOptions<T>) {
    this.options = options;
    this.state = {
      role: 'follower',
      epoch: 0,
      nextSeq: 0,
      lastAppliedSeq: -1,
      pending: [],
      resyncing: false,
    };
  }

  start(): void {
    if (this.disposed || this.channel) return;
    this.channel = new BroadcastChannel(this.options.channelName);
    this.channel.onmessage = (event: MessageEvent<ChannelMessage<T>>) => {
      this.handleMessage(event.data);
    };
    // Attempt to claim leadership; existing leaders will respond and we stay a follower.
    this.claimLeadership();
  }

  stop(): void {
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
    if (this.state.role === 'leader') {
      this.options.onLoseLeadership();
    }
    this.state.role = 'follower';
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Called by the leader to broadcast an ordered update to followers. */
  broadcast(payload: T): void {
    if (this.state.role !== 'leader' || !this.channel) return;
    const message: FanOutMessage<T> = {
      type: 'fanout',
      seq: this.state.nextSeq++,
      epoch: this.state.epoch,
      payload,
    };
    this.channel.postMessage(message);
  }

  /** Called when a follower becomes active (e.g. tab focused) to resync. */
  requestResync(): void {
    if (this.state.role === 'leader' || !this.channel) return;
    this.state.resyncing = true;
    const message: ResyncRequestMessage = {
      type: 'resync-request',
      lastSeq: this.state.lastAppliedSeq,
      epoch: this.state.epoch,
    };
    this.channel.postMessage(message);
  }

  private claimLeadership(): void {
    if (!this.channel) return;
    // Optimistically become leader; a real leader will re-assert via leader-claim.
    this.becomeLeader();
    const claim: LeaderClaimMessage = { type: 'leader-claim', epoch: this.state.epoch };
    this.channel.postMessage(claim);
  }

  private becomeLeader(): void {
    if (this.state.role === 'leader') return;
    this.state.role = 'leader';
    this.state.epoch += 1;
    this.state.nextSeq = 0;
    this.state.pending = [];
    this.state.resyncing = false;
    this.options.onBecomeLeader();
  }

  private becomeFollower(epoch: number): void {
    if (this.state.role === 'follower' && this.state.epoch === epoch) return;
    if (this.state.role === 'leader') {
      this.options.onLoseLeadership();
    }
    this.state.role = 'follower';
    this.state.epoch = epoch;
    this.state.lastAppliedSeq = -1;
    this.state.pending = [];
    this.state.resyncing = false;
  }

  private handleMessage(message: ChannelMessage<T>): void {
    switch (message.type) {
      case 'leader-claim':
        // Another tab is (or claims to be) leader; defer to it.
        this.becomeFollower(message.epoch);
        break;
      case 'fanout':
        this.handleFanOut(message);
        break;
      case 'resync-request':
        this.handleResyncRequest(message);
        break;
      case 'resync-response':
        this.handleResyncResponse(message);
        break;
    }
  }

  private handleFanOut(message: FanOutMessage<T>): void {
    if (this.state.role === 'leader') return;

    // New leader epoch: reset ordering and resync from scratch.
    if (message.epoch !== this.state.epoch) {
      this.becomeFollower(message.epoch);
      this.requestResync();
      return;
    }

    // While resyncing, buffer messages until the snapshot arrives.
    if (this.state.resyncing) {
      this.state.pending.push(message);
      return;
    }

    const expected = this.state.lastAppliedSeq + 1;
    if (message.seq === expected) {
      this.apply(message);
      this.drainPending();
    } else if (message.seq > expected) {
      // Gap detected: buffer and request a full resync.
      this.state.pending.push(message);
      this.requestResync();
    }
    // message.seq < expected: duplicate, ignore.
  }

  private apply(message: FanOutMessage<T>): void {
    this.state.lastAppliedSeq = message.seq;
    this.options.onFanOut(message.payload);
  }

  private drainPending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const expected = this.state.lastAppliedSeq + 1;
      const index = this.state.pending.findIndex((m) => m.seq === expected);
      if (index !== -1) {
        const [next] = this.state.pending.splice(index, 1);
        this.apply(next);
        progressed = true;
      }
    }
  }

  private handleResyncRequest(message: ResyncRequestMessage): void {
    if (this.state.role !== 'leader' || !this.channel) return;
    const response: ResyncResponseMessage<T> = {
      type: 'resync-response',
      epoch: this.state.epoch,
      seq: this.state.nextSeq,
      state: this.options.getState(),
    };
    this.channel.postMessage(response);
  }

  private handleResyncResponse(message: ResyncResponseMessage<T>): void {
    if (this.state.role === 'leader') return;
    if (message.epoch !== this.state.epoch) {
      this.becomeFollower(message.epoch);
    }
    // Adopt the full snapshot and resume ordered application from the snapshot seq.
    this.options.setState(message.state);
    this.state.lastAppliedSeq = message.seq - 1;
    this.state.resyncing = false;
    this.drainPending();
  }
}
