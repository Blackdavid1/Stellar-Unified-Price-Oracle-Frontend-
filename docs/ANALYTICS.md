# First-party telemetry

Schema version: **1**. Code: `src/telemetry/`. All emission is gated on explicit consent
(`spo.telemetry.consent.v1 = granted`); the default is no emission. Revoking consent clears
the local buffer. Events are validated with Zod: unknown events, unknown properties, wrong
types, or anything matching the PII denylist (email, wallet/public keys, pair/asset names,
URLs, etc.) are dropped. Timestamps are truncated to the hour; `installId` is a random UUID
not derived from user data.

| Event | Properties | Purpose | Retention |
|-------|-----------|---------|-----------|
| `dashboard_loaded` | `success`, `durationMs?` | Activation KPI (first successful load) | Local buffer, last 1000 events; server-side 90 days if an endpoint is configured |
| `feature_used` | `feature` (enum) | Feature adoption KPI | same |
| `route_viewed` | `route` (enum) | Retention / navigation funnels | same |
| `error_shown` | `kind` (enum) | Reliability of user-facing errors | same |

No pair-level or user-identifying data is ever collected.

## Notes and gaps

- The buffer is local (`spo.telemetry.buffer.v1`); no flush endpoint is wired yet. The issue's
  server side is out of scope for this frontend.
- Convergence: `utils/analytics.ts`, the field Web Vitals store (#722) and developer events
  (#720) have their own gates. They could route through `telemetry/track` and share
  `getConsent()` once merged; this layer deliberately does not import them.

## KPIs (`src/telemetry/kpi.ts`)

Pure functions over the local buffer, unit-tested in `kpi.test.ts`:

- **Activation** = installs with a `dashboard_loaded` (`success: true`) / all installs seen.
- **Feature adoption** = distinct installs with `feature_used` per feature / all installs.
- **Weekly retention** = per first-seen-week cohort, fraction of installs with any event in week N.
- **Funnel** = installs that reached each step in order (`route_viewed` -> `dashboard_loaded` -> `feature_used`).

The `/dev/kpi` route renders these. It is registered only in dev or when
`VITE_ENABLE_KPI_INSIGHTS=true` at build time, so production bundles exclude it otherwise.

## Confidence calibration (#666)

### What a confidence value means

A reported `confidence` is a 0–1 number attached to an aggregate. Operationally it is a
**claim about realized accuracy**: a confidence of `c` asserts that aggregates reported at
`c` are correct against the reference oracle roughly `c` of the time (equivalently, that the
realized error rate is about `1 - c`). It is *not* a measure of sample size, freshness, or
source count — those feed into the confidence model (`src/services/aggregation/confidence.ts`)
but the number itself is only meaningful if it tracks realized error.

### Calibration study

`src/services/aggregation/calibration.ts` builds the study from history:

1. Take historical aggregates that carry a reported `confidence` and a reference value
   (from `src/services/referenceOracle.ts`).
2. Bucket them by reported confidence (default 10 equal-width buckets over `[0, 1]`).
3. For each bucket compute the **realized error rate** = fraction of aggregates whose
   deviation from the reference exceeds the tolerance (`useReferenceDeviation`).
4. Emit a **reliability curve**: one `(reportedConfidence, realizedErrorRate, count)` point
   per non-empty bucket, plus the overall expected error `1 - confidence`.

A perfectly calibrated model has `realizedErrorRate ≈ 1 - reportedConfidence` in every bucket.

### Monotonicity check

Higher confidence must imply **lower** realized error. The study asserts this as a documented
invariant: walking the reliability curve in increasing confidence order, `realizedErrorRate`
must be non-increasing (within a tolerance for bucket noise). `checkMonotonicity()` returns the
violating bucket pairs so a regression is actionable rather than a bare boolean.

### Calibration mapping

When the curve is systematically off, `deriveCalibrationMapping()` fits a monotonic mapping
from reported confidence to calibrated confidence (the realized accuracy of its bucket). The
mapping is monotonic by construction (isotonic-style pooling of adjacent violators), so applying
it preserves the monotonicity invariant while pulling reported confidence toward realized accuracy.

### CI gate

Confidence-model changes are gated against calibration bounds in CI: the study runs over the
recorded history fixture and fails when the reliability curve drifts beyond the configured
bound (max per-bucket calibration error) or when the monotonicity check is violated. This keeps
an uncalibrated confidence number from shipping.
