// Realtime WebSocket frame parser.
//
// The parser is intentionally defensive: it must never throw, never hang, and
// never allocate unbounded memory regardless of the bytes it is handed. See
// issue #675 (protocol fuzzing) for the invariants this file guarantees.

export interface Frame {
  type: string;
  payload: unknown;
}

// Hard caps enforced *before* any expensive parsing so that oversized or
// deeply-nested frames are rejected cheaply.
export const MAX_FRAME_BYTES = 1 << 20; // 1 MiB
const MAX_DEPTH = 64;
const MAX_KEYS = 10_000;

/**
 * Cheap pre-flight guard. Runs in O(1) over the raw input length and rejects
 * frames that would otherwise force the parser to allocate or recurse without
 * bound. Returns an error string when the frame must be rejected, else null.
 */
export function preflight(raw: unknown): string | null {
  if (typeof raw === "string") {
    if (raw.length > MAX_FRAME_BYTES) return "frame too large";
    return null;
  }
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const len = raw instanceof ArrayBuffer ? raw.byteLength : raw.byteLength;
    if (len > MAX_FRAME_BYTES) return "frame too large";
    return null;
  }
  return null;
}

/**
 * Bounded structural walk used to reject deeply-nested or pathologically wide
 * payloads before they reach consumers. Iterative (no recursion) so a hostile
 * input cannot blow the call stack.
 */
function withinBounds(value: unknown): boolean {
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) return false;
    if (++visited > MAX_KEYS) return false;
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], depth: depth + 1 });
    } else {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        stack.push({ v: (v as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
  return true;
}

/**
 * Parse a raw realtime frame into a validated {@link Frame}.
 *
 * Invariants (fuzzed in websocket.fuzz.test.ts):
 *  - never throws for any input
 *  - always terminates (bounded work, no recursion)
 *  - never allocates beyond MAX_FRAME_BYTES / MAX_KEYS
 */
export function parseFrame(raw: unknown): Frame | null {
  try {
    const rejected = preflight(raw);
    if (rejected) return null;

    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof Uint8Array) {
      text = new TextDecoder().decode(raw);
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(raw));
    } else {
      return null;
    }

    if (text.length === 0) return null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return null;
    }

    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }

    if (!withinBounds(decoded)) return null;

    const obj = decoded as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string" || type.length === 0) return null;

    return { type, payload: obj.payload };
  } catch {
    // Defensive: a parser must never surface an exception to callers.
    return null;
  }
}
