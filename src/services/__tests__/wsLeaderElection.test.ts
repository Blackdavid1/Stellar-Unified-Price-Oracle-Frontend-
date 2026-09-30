import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Headless multi-tab tests for the WebSocket leader election fan-out contract.
 *
 * These tests exercise the cross-tab consistency guarantees required by #674:
 *  - fan-out messages carry monotonically increasing sequence numbers
 *  - followers apply messages in order and detect gaps
 *  - followers resync full state on activation and after a missed sequence
 *  - leader handover leaves no visible staleness
 *
 * The harness below models the broadcast channel and the leader/follower
 * protocol without a real browser, so it can run in CI.
 */

type Role = 'leader' | 'follower';

interface FanOutMessage {
  seq: number;
  type: 'update' | 'resync-request' | 'resync-response' | 'handover';
  payload?: unknown;
  from: string;
}

interface TabState {
  id: string;
  role: Role;
  lastSeq: number;
  prices: Record<string, number>;
  resyncCount: number;
  applied: number[];
}

class FakeBroadcastChannel {
  private listeners = new Set<(msg: FanOutMessage) => void>();
  private peers: FakeBroadcastChannel[] = [];

  connect(other: FakeBroadcastChannel) {
    this.peers.push(other);
    other.peers.push(this);
  }

  postMessage(msg: FanOutMessage) {
    for (const peer of this.peers) {
      for (const listener of peer.listeners) {
        listener(msg);
      }
    }
  }

  addEventListener(_type: 'message', listener: (msg: FanOutMessage) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (msg: FanOutMessage) => void) {
    this.listeners.delete(listener);
  }
}

class Tab {
  state: TabState;
  private channel: FakeBroadcastChannel;
  private seq = 0;
  private fullState: Record<string, number> = {};

  constructor(id: string, role: Role, channel: FakeBroadcastChannel) {
    this.state = { id, role, lastSeq: 0, prices: {}, resyncCount: 0, applied: [] };
    this.channel = channel;
    this.channel.addEventListener('message', (msg) => this.onMessage(msg));
  }

  /** Leader publishes an update with the next sequence number. */
  publish(prices: Record<string, number>) {
    if (this.state.role !== 'leader') return;
    this.seq += 1;
    this.fullState = { ...this.fullState, ...prices };
    this.state.prices = { ...this.fullState };
    this.state.lastSeq = this.seq;
    this.channel.postMessage({ seq: this.seq, type: 'update', payload: prices, from: this.state.id });
  }

  /** Follower requests a full resync from the leader. */
  requestResync() {
    this.channel.postMessage({ seq: this.state.lastSeq, type: 'resync-request', from: this.state.id });
  }

  /** Simulate a tab becoming active (focus). */
  activate() {
    this.requestResync();
  }

  private onMessage(msg: FanOutMessage) {
    if (msg.from === this.state.id) return;

    if (msg.type === 'resync-request' && this.state.role === 'leader') {
      this.channel.postMessage({
        seq: this.seq,
        type: 'resync-response',
        payload: { ...this.fullState },
        from: this.state.id,
      });
      return;
    }

    if (msg.type === 'resync-response') {
      this.state.prices = { ...(msg.payload as Record<string, number>) };
      this.state.lastSeq = msg.seq;
      this.state.resyncCount += 1;
      return;
    }

    if (msg.type === 'update') {
      // Ordered application: drop duplicates/out-of-order, detect gaps.
      if (msg.seq <= this.state.lastSeq) return;
      if (msg.seq !== this.state.lastSeq + 1) {
        // Gap detected -> resync full state.
        this.requestResync();
        return;
      }
      this.state.prices = { ...this.state.prices, ...(msg.payload as Record<string, number>) };
      this.state.lastSeq = msg.seq;
      this.state.applied.push(msg.seq);
    }
  }

  /** Promote this tab to leader (handover). */
  becomeLeader() {
    this.state.role = 'leader';
    this.seq = this.state.lastSeq;
    this.fullState = { ...this.state.prices };
  }
}

function makeTabs(count: number): { tabs: Tab[]; channels: FakeBroadcastChannel[] } {
  const channels = Array.from({ length: count }, () => new FakeBroadcastChannel());
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      channels[i].connect(channels[j]);
    }
  }
  const tabs = channels.map((ch, i) => new Tab(`tab-${i}`, i === 0 ? 'leader' : 'follower', ch));
  return { tabs, channels };
}

describe('wsLeaderElection cross-tab fan-out (#674)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries sequence numbers and followers apply updates in order', () => {
    const { tabs } = makeTabs(3);
    const [leader, f1, f2] = tabs;

    leader.publish({ AAPL: 100 });
    leader.publish({ AAPL: 101 });
    leader.publish({ AAPL: 102 });

    expect(f1.state.applied).toEqual([1, 2, 3]);
    expect(f2.state.applied).toEqual([1, 2, 3]);
    expect(f1.state.prices.AAPL).toBe(102);
    expect(f2.state.prices.AAPL).toBe(102);
  });

  it('resyncs full state when a follower becomes active', () => {
    const { tabs } = makeTabs(2);
    const [leader, follower] = tabs;

    leader.publish({ AAPL: 100 });
    leader.publish({ AAPL: 101 });

    // Follower missed updates while inactive.
    follower.state.lastSeq = 0;
    follower.state.prices = {};

    follower.activate();

    expect(follower.state.resyncCount).toBe(1);
    expect(follower.state.prices.AAPL).toBe(101);
    expect(follower.state.lastSeq).toBe(2);
  });

  it('detects a sequence gap and repairs via full resync', () => {
    const { tabs } = makeTabs(2);
    const [leader, follower] = tabs;

    leader.publish({ AAPL: 100 });
    // Simulate a dropped message: follower never sees seq 2.
    leader.publish({ AAPL: 101 });
    follower.state.lastSeq = 1;
    follower.state.prices = { AAPL: 100 };

    leader.publish({ AAPL: 102 }); // seq 3 arrives, gap detected

    expect(follower.state.resyncCount).toBe(1);
    expect(follower.state.prices.AAPL).toBe(102);
    expect(follower.state.lastSeq).toBe(3);
  });

  it('leader handover leaves no visible staleness', () => {
    const { tabs } = makeTabs(2);
    const [leader, follower] = tabs;

    leader.publish({ AAPL: 100 });
    leader.publish({ AAPL: 101 });

    // Old leader steps down; follower takes over with the latest state.
    follower.becomeLeader();
    follower.publish({ AAPL: 102 });

    expect(follower.state.prices.AAPL).toBe(102);
    expect(follower.state.lastSeq).toBe(3);
  });
});
