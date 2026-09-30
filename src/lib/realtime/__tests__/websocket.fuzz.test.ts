import { describe, it, expect } from 'vitest';
import { parseFrame, MAX_FRAME_BYTES, MAX_FRAME_DEPTH } from '../websocket';

/**
 * Protocol fuzzing for the realtime frame parser (#675).
 *
 * Invariants under test:
 *   1. parseFrame never throws, regardless of input.
 *   2. parseFrame always terminates within a bounded number of steps.
 *   3. parseFrame never allocates beyond a memory cap for a single frame.
 *   4. Oversized / deeply-nested frames are rejected cheaply (before parsing).
 *
 * Minimized failures discovered by the fuzzer are kept below as permanent
 * regression seeds so they run on every CI pass.
 */

// Deterministic PRNG so fuzz runs are reproducible across CI machines.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const ITERATIONS = 2000;
const TIME_BUDGET_MS = 2000;
const MEMORY_CAP_BYTES = 8 * 1024 * 1024;

function randomBytes(rng: () => number, maxLen: number): Uint8Array {
  const len = Math.floor(rng() * maxLen);
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(rng() * 256);
  return buf;
}

function randomStructured(rng: () => number, depth = 0): unknown {
  const roll = rng();
  if (depth > 6 || roll < 0.3) {
    const scalars = [null, true, false, 0, -1, 1.5, '', 'x', '\u0000', '\ud800'];
    return scalars[Math.floor(rng() * scalars.length)];
  }
  if (roll < 0.6) {
    const arr: unknown[] = [];
    const n = Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) arr.push(randomStructured(rng, depth + 1));
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) obj['k' + i] = randomStructured(rng, depth + 1);
  return obj;
}

function encodeStructured(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    return new Uint8Array(0);
  }
}

function assertInvariants(input: Uint8Array): void {
  const start = performance.now();
  let result: unknown;
  expect(() => {
    result = parseFrame(input);
  }).not.toThrow();
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  // Result must be a bounded, serializable value (no unbounded growth).
  if (result !== undefined && result !== null) {
    const size = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(size).toBeLessThan(MEMORY_CAP_BYTES);
  }
}

describe('parseFrame fuzzing (#675)', () => {
  it('never throws, hangs, or leaks on purely random bytes', () => {
    const rng = makeRng(0x675);
    for (let i = 0; i < ITERATIONS; i++) {
      assertInvariants(randomBytes(rng, 512));
    }
  });

  it('never throws, hangs, or leaks on structured inputs', () => {
    const rng = makeRng(0x6750);
    for (let i = 0; i < ITERATIONS; i++) {
      assertInvariants(encodeStructured(randomStructured(rng)));
    }
  });

  it('rejects oversized frames cheaply before parsing', () => {
    const oversized = new Uint8Array(MAX_FRAME_BYTES + 1);
    const start = performance.now();
    const result = parseFrame(oversized);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    // Cheap rejection: must not scan/parse the whole payload.
    expect(elapsed).toBeLessThan(50);
  });

  it('rejects deeply nested frames cheaply before parsing', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < MAX_FRAME_DEPTH + 10; i++) nested = [nested];
    const input = encodeStructured(nested);
    const start = performance.now();
    const result = parseFrame(input);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(50);
  });

  // --- Permanent regression seeds (minimized fuzz failures) ---
  const seeds: Array<[string, Uint8Array]> = [
    ['empty frame', new Uint8Array(0)],
    ['truncated header', new Uint8Array([0x81])],
    ['invalid utf-8', new Uint8Array([0x81, 0x02, 0xff, 0xfe])],
    ['lone surrogate', new TextEncoder().encode('"\\ud800"')],
    ['deeply nested json', encodeStructured((() => {
      let v: unknown = 0;
      for (let i = 0; i < MAX_FRAME_DEPTH + 5; i++) v = [v];
      return v;
    })())],
    ['oversized payload', new Uint8Array(MAX_FRAME_BYTES + 1)],
  ];

  it.each(seeds)('regression seed: %s', (_name, input) => {
    assertInvariants(input);
  });
});
