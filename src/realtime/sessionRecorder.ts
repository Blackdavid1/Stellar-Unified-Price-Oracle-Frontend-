/**
 * Deterministic session replay for the realtime stream (#670).
 *
 * Records inbound realtime frames with timestamps into a compact, redacted
 * session file, and replays them through the real client on the virtual clock
 * (#609) so timing is deterministic. Supports 1x, accelerated and step modes.
 */

/** A single recorded inbound frame. */
export interface RecordedFrame {
  /** Milliseconds since the start of the recording. */
  t: number;
  /** Frame payload (already redacted). */
  data: unknown;
}

/** A compact, redacted session file. */
export interface SessionFile {
  version: 1;
  /** ISO timestamp of when the recording started. */
  startedAt: string;
  /** Total recorded duration in milliseconds. */
  duration: number;
  frames: RecordedFrame[];
}

/** Replay speed: 1x, accelerated (n > 1), or step (manual advance). */
export type ReplayMode = number | "step";

/** Minimal virtual clock surface (see #609). */
export interface VirtualClock {
  now(): number;
  setTimeout(fn: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Minimal real client surface used for replay. */
export interface ReplayClient {
  handleFrame(data: unknown): void;
}

/** Options for {@link SessionRecorder}. */
export interface RecorderOptions {
  /** Maximum number of frames retained (bounded file). Default 5000. */
  maxFrames?: number;
  /** Maximum recorded duration in ms; older frames are dropped. Default 5 min. */
  maxDurationMs?: number;
  /** Field names to redact from frame payloads. */
  redactKeys?: string[];
  /** Clock used for timestamps; defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_REDACT_KEYS = [
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "password",
  "secret",
  "apiKey",
  "cookie",
];

const REDACTED = "[redacted]";

/**
 * Recursively redact sensitive fields from a frame payload. Returns a new
 * value; the input is never mutated.
 */
export function redactFrame(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactFrame(item, keys));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.includes(k) ? REDACTED : redactFrame(v, keys);
    }
    return out;
  }
  return value;
}

/**
 * Records inbound realtime frames into a bounded, redacted session file.
 */
export class SessionRecorder {
  private readonly maxFrames: number;
  private readonly maxDurationMs: number;
  private readonly redactKeys: string[];
  private readonly now: () => number;
  private readonly frames: RecordedFrame[] = [];
  private startedAt = 0;
  private recording = false;

  constructor(options: RecorderOptions = {}) {
    this.maxFrames = options.maxFrames ?? 5000;
    this.maxDurationMs = options.maxDurationMs ?? 5 * 60 * 1000;
    this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.frames.length = 0;
    this.startedAt = this.now();
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  /** Record one inbound frame. No-op when not recording. */
  record(data: unknown): void {
    if (!this.recording) return;
    const t = this.now() - this.startedAt;
    this.frames.push({ t, data: redactFrame(data, this.redactKeys) });
    this.enforceBounds();
  }

  /** Drop oldest frames to keep the file bounded in count and duration. */
  private enforceBounds(): void {
    while (this.frames.length > this.maxFrames) this.frames.shift();
    const newest = this.frames[this.frames.length - 1];
    if (!newest) return;
    const cutoff = newest.t - this.maxDurationMs;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }

  /** Serialize the current recording into a compact session file. */
  toSessionFile(): SessionFile {
    const last = this.frames[this.frames.length - 1];
    return {
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      duration: last ? last.t : 0,
      frames: this.frames.map((f) => ({ t: f.t, data: f.data })),
    };
  }

  /** Serialize to a compact JSON string suitable for a fixture file. */
  serialize(): string {
    return JSON.stringify(this.toSessionFile());
  }
}

/** Parse a session file from JSON, validating its shape. */
export function parseSessionFile(json: string): SessionFile {
  const parsed = JSON.parse(json) as SessionFile;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.frames)) {
    throw new Error("Invalid session file");
  }
  return parsed;
}

/**
 * Replays a recorded session through the real client on the virtual clock.
 *
 * - `mode` as a number: 1 = real time, >1 = accelerated.
 * - `mode` as "step": frames are delivered only via {@link step}.
 */
export class SessionReplayer {
  private readonly clock: VirtualClock;
  private readonly client: ReplayClient;
  private readonly session: SessionFile;
  private readonly mode: ReplayMode;
  private index = 0;
  private handle: unknown = null;
  private baseTime = 0;
  private playing = false;

  constructor(
    session: SessionFile,
    client: ReplayClient,
    clock: VirtualClock,
    mode: ReplayMode = 1,
  ) {
    this.session = session;
    this.client = client;
    this.clock = clock;
    this.mode = mode;
  }

  /** Begin replay. In step mode this only arms the replayer. */
  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.baseTime = this.clock.now();
    if (this.mode !== "step") this.scheduleNext();
  }

  /** Deliver the next frame immediately (step mode / manual advance). */
  step(): boolean {
    if (this.index >= this.session.frames.length) return false;
    const frame = this.session.frames[this.index++];
    this.client.handleFrame(frame.data);
    return this.index < this.session.frames.length;
  }

  /** Stop replay and cancel any pending scheduled frame. */
  stop(): void {
    this.playing = false;
    if (this.handle !== null) {
      this.clock.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private scheduleNext(): void {
    if (!this.playing || this.index >= this.session.frames.length) {
      this.playing = false;
      return;
    }
    const frame = this.session.frames[this.index];
    const speed = this.mode === "step" ? 1 : this.mode;
    const target = this.baseTime + frame.t / speed;
    const delay = Math.max(0, target - this.clock.now());
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.index++;
      this.client.handleFrame(frame.data);
      this.scheduleNext();
    }, delay);
  }
}
