# Living Threat Model

This document is the entry point for security reviews. It maps our assets,
actors, trust boundaries, and mitigations to the code and tests that enforce
them. It is a *living* document: it must be updated whenever a change adds a
trust boundary or an external origin (see [Drift check](#drift-check)).

## Assets

| Asset | Description | Where it lives |
| --- | --- | --- |
| `signing-keys` | Private keys used for on-chain signing | `src/utils/signing.ts` |
| `user-session` | Authenticated user session / tokens | `src/utils/auth.ts` |
| `webhook-secrets` | Shared secrets used to verify inbound webhooks | `src/utils/webhooks.ts` |
| `telemetry-data` | Startup/performance telemetry emitted to external origins | `src/hooks/useStartupMetrics.ts` |
| `build-artifacts` | Bundled client code shipped to users | `.github/workflows/ci.yml` |

## Actors

| Actor | Trust level | Notes |
| --- | --- | --- |
| `end-user` | Untrusted | Browser client; can tamper with any client-side input |
| `external-origin` | Untrusted | Third-party origins contacted at runtime |
| `webhook-sender` | Untrusted | Any party that can POST to our webhook endpoint |
| `ci-runner` | Trusted | Runs the drift check and build pipeline |
| `maintainer` | Trusted | Reviews and merges changes to this model |

## Trust boundaries

Each boundary below is a place where data crosses from a less-trusted to a
more-trusted context. The drift check (see below) fails CI when a new boundary
or external origin appears without a matching entry here.

| Boundary | From → To | Mitigation | Code | Test |
| --- | --- | --- | --- | --- |
| `client-to-signing` | `end-user` → `signing-keys` | Keys never leave the signing module; inputs validated before signing | `src/utils/signing.ts` | `src/utils/signing.test.ts` |
| `client-to-session` | `end-user` → `user-session` | Session tokens are validated and scoped per request | `src/utils/auth.ts` | `src/utils/auth.test.ts` |
| `webhook-to-app` | `webhook-sender` → `webhook-secrets` | Inbound webhooks verified against a shared secret before processing | `src/utils/webhooks.ts` | `src/utils/webhooks.test.ts` |
| `app-to-external-origin` | `telemetry-data` → `external-origin` | Telemetry is allow-listed to known origins and stripped of PII | `src/hooks/useStartupMetrics.ts` | `src/hooks/useStartupMetrics.test.ts` |
| `ci-to-release` | `ci-runner` → `build-artifacts` | Drift check + build must pass before artifacts are published | `.github/workflows/ci.yml` | `scripts/check-threat-model-drift.mjs` |

## Mitigations

Every mitigation is linked to the code that implements it and the test that
proves it. A mitigation without both links is considered incomplete.

- **M1 — Input validation before signing.** `src/utils/signing.ts` validates
  and normalizes all inputs before they reach the key material. Tested in
  `src/utils/signing.test.ts`.
- **M2 — Scoped session tokens.** `src/utils/auth.ts` issues and validates
  session tokens scoped to a single request. Tested in
  `src/utils/auth.test.ts`.
- **M3 — Webhook signature verification.** `src/utils/webhooks.ts` verifies
  the inbound signature against `webhook-secrets` before processing. Tested in
  `src/utils/webhooks.test.ts`.
- **M4 — Telemetry origin allow-list.** `src/hooks/useStartupMetrics.ts`
  restricts telemetry to allow-listed origins and strips PII. Tested in
  `src/hooks/useStartupMetrics.test.ts`.
- **M5 — CI drift gate.** `scripts/check-threat-model-drift.mjs` fails the
  build when a new trust boundary or external origin is not documented here.
  Wired into `.github/workflows/ci.yml`.

## Drift check

The drift check scans the codebase for trust boundaries and external origins
and compares them against the entries in this document. It fails CI when it
finds a boundary or origin that has no matching entry above.

- Script: `scripts/check-threat-model-drift.mjs`
- CI wiring: `.github/workflows/ci.yml` (runs on every pull request)

To add a new boundary or external origin, add a row to the relevant table and
a mitigation entry with its code and test links. The drift check will pass once
the entry exists.

## Review cadence

- **On every surface-adding change:** any PR that introduces a new trust
  boundary or external origin must update this document in the same PR. The
  drift check enforces this.
- **Scheduled review:** the model is reviewed at least once per quarter by a
  maintainer, and the review date is recorded below.
- **Entry point:** security reviews start from this document; reviewers use the
  mitigation table to confirm each control still has code and test coverage.

| Review date | Reviewer | Notes |
| --- | --- | --- |
| _pending_ | _maintainer_ | Initial model added with drift check |
