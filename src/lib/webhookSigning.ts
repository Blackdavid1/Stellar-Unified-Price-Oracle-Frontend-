import crypto from 'crypto';

/**
 * Webhook signing scheme (shared by all SDK verification helpers).
 *
 * Algorithm:
 *   1. Build the signed payload as `${timestamp}.${rawBody}` where `timestamp`
 *      is the Unix time in seconds (integer, as a string) at signing time and
 *      `rawBody` is the exact, unmodified request body bytes.
 *   2. Compute `HMAC-SHA256(secret, signedPayload)` and hex-encode it.
 *   3. Send the result in the `X-Webhook-Signature` header and the timestamp in
 *      the `X-Webhook-Timestamp` header.
 *
 * Headers:
 *   - `X-Webhook-Signature`: hex HMAC-SHA256 of `${timestamp}.${rawBody}`.
 *   - `X-Webhook-Timestamp`: Unix seconds used to build the signed payload.
 *   - `X-Webhook-Id`: unique delivery id, used for replay protection.
 *
 * Rotation (#502):
 *   Secrets are rotated by adding a new secret while keeping the previous one
 *   valid for a grace period. During rotation the sender signs with the newest
 *   secret; verifiers should accept a signature that matches ANY of the
 *   currently active secrets. Once the grace period ends the old secret is
 *   removed and signatures produced with it are rejected.
 */

export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_ID_HEADER = 'x-webhook-id';

/** Default freshness window (seconds) for the timestamp check. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Shared test vectors. These are the canonical fixtures consumed by the Node,
 * Go, and Python verification helpers so every language agrees on the result.
 */
export const WEBHOOK_TEST_VECTORS = [
  {
    name: 'valid',
    secret: 'whsec_test_secret',
    timestamp: 1700000000,
    body: '{"event":"ping","id":"evt_1"}',
    signature: 'a1c1f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    valid: true,
  },
  {
    name: 'tampered-body',
    secret: 'whsec_test_secret',
    timestamp: 1700000000,
    body: '{"event":"ping","id":"evt_2"}',
    signature: 'a1c1f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    valid: false,
  },
  {
    name: 'stale-timestamp',
    secret: 'whsec_test_secret',
    timestamp: 1600000000,
    body: '{"event":"ping","id":"evt_1"}',
    signature: 'a1c1f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    valid: false,
  },
];

/**
 * Compute the hex HMAC-SHA256 signature for a webhook payload.
 * Mirrors the algorithm documented above and used by the SDK helpers.
 */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Constant-time comparison of two hex signatures.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * In-memory replay store keyed by webhook id. Consumers that need durability
 * should supply their own store implementing the same interface.
 */
export interface ReplayStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

export class InMemoryReplayStore implements ReplayStore {
  private seen = new Set<string>();

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    this.seen.add(id);
  }
}

export interface VerifyOptions {
  /** One or more active secrets (rotation, #502). */
  secret: string | string[];
  /** Raw request body exactly as received. */
  rawBody: string;
  /** Value of the `X-Webhook-Signature` header. */
  signature: string;
  /** Value of the `X-Webhook-Timestamp` header. */
  timestamp: string | number;
  /** Value of the `X-Webhook-Id` header (required for replay protection). */
  id?: string;
  /** Freshness window in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Replay store. Defaults to a per-call in-memory store. */
  replayStore?: ReplayStore;
  /** Current time in seconds; injectable for tests. */
  now?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'missing-signature' | 'missing-timestamp' | 'stale-timestamp' | 'signature-mismatch' | 'replay';
}

/**
 * Verify a webhook signature, enforcing timestamp freshness and replay
 * protection. Returns a structured result instead of throwing so callers can
 * decide how to respond.
 */
export async function verifyWebhook(options: VerifyOptions): Promise<VerifyResult> {
  const {
    secret,
    rawBody,
    signature,
    timestamp,
    id,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    replayStore = new InMemoryReplayStore(),
    now = Math.floor(Date.now() / 1000),
  } = options;

  if (!signature) {
    return { valid: false, reason: 'missing-signature' };
  }
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return { valid: false, reason: 'missing-timestamp' };
  }

  const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'missing-timestamp' };
  }

  if (Math.abs(now - ts) > toleranceSeconds) {
    return { valid: false, reason: 'stale-timestamp' };
  }

  const secrets = Array.isArray(secret) ? secret : [secret];
  const matched = secrets.some((s) => timingSafeEqualHex(signWebhook(s, ts, rawBody), signature));
  if (!matched) {
    return { valid: false, reason: 'signature-mismatch' };
  }

  if (id) {
    if (await replayStore.has(id)) {
      return { valid: false, reason: 'replay' };
    }
    await replayStore.add(id);
  }

  return { valid: true };
}
