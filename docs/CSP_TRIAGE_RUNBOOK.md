# CSP Violation Triage Runbook

This runbook describes how to review, classify, and act on Content Security
Policy (CSP) violation reports captured by the reporting pipeline
(`cspReporting.ts` / `CspViolationsPanel`).

## Goals

- Classify every violation by source so real regressions are not lost in noise.
- Deduplicate and rate-limit reports so a flood cannot become a DoS.
- Fail the appropriate gate when a **first-party** violation is detected.

## Pipeline overview

1. **Ingest** — the browser posts `application/csp-report` payloads to the
   reporting endpoint. Each report is normalized into a `CspViolation` record.
2. **Classify** — a rule set assigns each violation a `source`:
   - `extension` — caused by a browser extension or injected user script.
   - `injected-script` — caused by third-party/injected script not owned by us.
   - `first-party` — caused by our own code or assets (a real bug).
3. **Deduplicate** — reports are keyed by a stable fingerprint
   (`directive` + `blockedUri` + `documentUri` + `sourceFile` + `lineNumber`)
   so repeated hits collapse into a single entry with a count.
4. **Rate-limit** — per-fingerprint and global volume caps drop excess reports
   and increment a `suppressed` counter instead of storing them.
5. **Route** — classified, deduped reports flow into the reviewable pipeline
   surfaced by `CspViolationsPanel`.

## Classification rules

| Signal | Classification |
| --- | --- |
| `blockedUri` / `sourceFile` matches a known extension scheme (`chrome-extension:`, `moz-extension:`, `safari-extension:`) | `extension` |
| `blockedUri` is a third-party origin not in our allowlist, or `sourceFile` is `eval`/`inline` from an unknown origin | `injected-script` |
| `documentUri` is our own origin and `sourceFile` is a first-party bundle/asset | `first-party` |
| Anything unmatched | `first-party` (fail-safe: treat unknown as our bug) |

Rules live alongside the classifier so they can be extended without touching the
pipeline. Keep the fail-safe default: unknown violations are treated as
first-party so they are never silently ignored.

## Dedupe and volume limits

- **Fingerprint** each report; store one entry per fingerprint with a `count`.
- **Per-fingerprint cap**: stop incrementing after a threshold (e.g. 100) and
  mark the entry as `flooded`.
- **Global cap**: bound the number of distinct fingerprints retained per window
  (e.g. 500 per 5 minutes). Excess reports increment `suppressed`.
- Never let report volume grow unbounded — the caps are the DoS guard.

## Gating first-party violations

- `first-party` violations are surfaced as build/regression failures.
- In CI, the CSP gate fails when any `first-party` violation is present in the
  run's report set.
- `extension` and `injected-script` violations are reported but do **not** fail
  the gate; they are noise from the environment.

## Triage workflow

1. Open `CspViolationsPanel` and filter by `source`.
2. Review `first-party` entries first — these are regressions.
3. For each first-party violation:
   - Reproduce locally with the same directive and blocked URI.
   - Fix the offending code/asset or update the CSP policy intentionally.
   - Add a regression test where practical.
4. Confirm `extension` / `injected-script` entries are environmental; if a
   pattern recurs, add a classification rule rather than ignoring it.
5. Re-run the CSP gate; it must pass with zero first-party violations.

## Escalation

- If the global cap is hit repeatedly, investigate for a report flood or a
  misconfigured policy before raising limits.
- If a violation cannot be classified, default to `first-party` and file a bug.
