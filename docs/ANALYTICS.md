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
