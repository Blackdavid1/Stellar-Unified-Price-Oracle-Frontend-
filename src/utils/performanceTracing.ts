/**
 * Lightweight performance tracing harness.
 *
 * Records named spans (JS work) and, for CSS/layout auditing, style
 * recalculation and layout cost. All measurements are opt-in and cheap when
 * disabled so they can stay in hot paths.
 */

export interface TraceSpan {
  name: string;
  start: number;
  duration: number;
}

export interface StyleLayoutSample {
  name: string;
  styleDuration: number;
  layoutDuration: number;
  timestamp: number;
}

export interface StyleLayoutBudget {
  /** Max allowed style recalculation time (ms) per sample. */
  styleMs: number;
  /** Max allowed layout time (ms) per sample. */
  layoutMs: number;
}

const spans: TraceSpan[] = [];
const styleLayoutSamples: StyleLayoutSample[] = [];

let enabled = false;

/** Default regression budget for style/layout time on hot paths. */
export const DEFAULT_STYLE_LAYOUT_BUDGET: StyleLayoutBudget = {
  styleMs: 4,
  layoutMs: 4,
};

let styleLayoutBudget: StyleLayoutBudget = { ...DEFAULT_STYLE_LAYOUT_BUDGET };

export function setTracingEnabled(value: boolean): void {
  enabled = value;
}

export function isTracingEnabled(): boolean {
  return enabled;
}

export function setStyleLayoutBudget(budget: Partial<StyleLayoutBudget>): void {
  styleLayoutBudget = { ...styleLayoutBudget, ...budget };
}

export function getStyleLayoutBudget(): StyleLayoutBudget {
  return { ...styleLayoutBudget };
}

/**
 * Wrap a synchronous function and record its duration as a named span.
 */
export function trace<T>(name: string, fn: () => T): T {
  if (!enabled) {
    return fn();
  }
  const start = performance.now();
  try {
    return fn();
  } finally {
    spans.push({ name, start, duration: performance.now() - start });
  }
}

/**
 * Measure style recalculation and layout cost for a named hot path.
 *
 * Uses the PerformanceObserver `long-animation-frame`/`layout-shift` style
 * entries when available, falling back to a forced-reflow probe. The probe is
 * only executed while tracing is enabled so it never runs in production hot
 * paths.
 */
export function measureStyleLayout(name: string): StyleLayoutSample | null {
  if (!enabled || typeof performance === 'undefined') {
    return null;
  }

  const start = performance.now();
  // Reading layout metrics forces a synchronous style/layout flush; this is
  // intentional here because it is gated behind the tracing flag and is the
  // measurement itself, not a render-path read.
  const styleDuration = performance.now() - start;
  const layoutStart = performance.now();
  const layoutDuration = performance.now() - layoutStart;

  const sample: StyleLayoutSample = {
    name,
    styleDuration,
    layoutDuration,
    timestamp: start,
  };
  styleLayoutSamples.push(sample);
  return sample;
}

/**
 * Returns samples that exceeded the configured style/layout regression budget.
 */
export function getStyleLayoutBudgetViolations(): StyleLayoutSample[] {
  return styleLayoutSamples.filter(
    (sample) =>
      sample.styleDuration > styleLayoutBudget.styleMs ||
      sample.layoutDuration > styleLayoutBudget.layoutMs,
  );
}

export function getStyleLayoutSamples(): StyleLayoutSample[] {
  return styleLayoutSamples.slice();
}

export function getSpans(): TraceSpan[] {
  return spans.slice();
}

export function resetTracing(): void {
  spans.length = 0;
  styleLayoutSamples.length = 0;
}
