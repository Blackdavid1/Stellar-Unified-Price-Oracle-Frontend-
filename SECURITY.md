# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a
public GitHub issue**.  Instead, report it privately using one of these channels:

- **GitHub private vulnerability reporting** — use the "Report a vulnerability"
  button on the [Security tab](../../security/advisories/new) of this repository.
- **Email** — send details to the maintainers listed in `package.json` (or open a
  blank private advisory if no email is listed).

You will receive an acknowledgement within **72 hours** and a resolution timeline
within **7 days** of the initial report.

This policy is also published at `/.well-known/security.txt` (RFC 9116) on the
deployed site, and as a human-readable page at `/security`, which is linked from
the site footer.

---

## Threat Model (#685)

This is the **living threat model** and the entry point for security reviews. It
maps our assets, the actors who can touch them, the trust boundaries between them,
and the mitigations we rely on. Every mitigation links to the code that implements
it and the test that guards it. The model is checked automatically for drift (see
[Drift check](#drift-check-685)) and reviewed on a schedule (see
[Review cadence](#review-cadence-685)).

### Assets

| Asset | Where it lives |
|-------|----------------|
| User session / auth tokens | browser storage, `src/hooks/useAuth.ts` |
| On-chain signing keys & signed transactions | wallet provider, `src/utils/signing.ts` |
| API credentials & webhook secrets | server env, `api/` serverless functions |
| Telemetry / analytics events | `src/hooks/useAnalytics.ts`, `src/utils/cspReporting.ts` |
| Build & release artifacts | `.github/workflows/release.yml` |

### Actors

| Actor | Trust level |
|-------|-------------|
| Anonymous internet user | untrusted |
| Authenticated user | semi-trusted |
| Third-party origins (CDNs, analytics, RPC) | untrusted until pinned |
| CI / release pipeline (GitHub OIDC) | trusted |
| Maintainers | trusted |

### Trust boundaries

Each boundary below is a place where data crosses from a less-trusted to a
more-trusted context. **Adding a new boundary or a new external origin requires a
new entry here** — the drift check enforces this.

| # | Boundary | Entry point |
|---|----------|-------------|
| B1 | Browser ↔ third-party CDN | `index.html`, `src/hooks/useAnalytics.ts` |
| B2 | Browser ↔ our API | `api/*.ts` serverless functions |
| B3 | Browser ↔ wallet / chain RPC | `src/utils/signing.ts` |
| B4 | Inbound webhooks → server | `api/webhooks.ts` |
| B5 | CI → release artifacts | `.github/workflows/release.yml` |

### Mitigations

| Mitigation | Boundary | Code | Test |
|------------|----------|------|------|
| Subresource Integrity on cross-origin assets | B1 | `scripts/check-sri.js` | `scripts/check-sri.js` (CI gate) |
| Strict Content-Security-Policy + reporting | B1, B2 | `vercel.json`, `src/utils/cspReporting.ts`, `api/csp-report.ts` | `src/utils/cspReporting.test.ts` |
| Centralized authorization mapping | B2 | `src/utils/authz.ts` | `src/utils/authz.test.ts` |
| Webhook signature verification | B4 | `api/webhooks.ts` | `api/webhooks.test.ts` |
| SLSA build provenance (OIDC-signed) | B5 | `.github/workflows/release.yml` | release workflow attestation step |
| Dependency audit gate (`--audit-level=high`) | all | `.github/workflows/ci.yml` | CI `npm audit` step |

### Drift check (#685)

`scripts/check-threat-model.js` scans the codebase for trust boundaries and
external origins and fails CI when one is not represented in the tables above:

- **External origins** — every cross-origin host referenced in `index.html`,
  `vercel.json`, and `src/**/*.{ts,tsx}` must appear in a trust-boundary row.
- **Trust boundaries** — every `api/*.ts` serverless function and every
  `src/utils/signing.ts`-style signing entry point must map to a boundary row.

Run it locally with `node scripts/check-threat-model.js`. CI
(`.github/workflows/ci.yml`) runs it on every push/PR and fails the build on any
unmapped boundary or origin. To add a new surface, add the corresponding row to
the tables above in the same PR — the check will otherwise block the merge.

### Review cadence (#685)

- **Scheduled** — reviewed at least **quarterly** (and on the first security
  workflow run of each quarter) by a maintainer, who updates the tables and the
  `reviewBy` date below.
- **On change** — any PR that adds a trust boundary or external origin must update
  this model; the drift check enforces it.
- **On incident** — after any security incident, the model is revisited and the
  relevant mitigation/test links are corrected.

_Last reviewed: 2025-01-01 · Next review due: 2025-04-01_

---

## Triage & Disclosure Process (#500)

1. **Acknowledgement** — a maintainer confirms receipt within 72 hours.
2. **Triage** — the report is reproduced and assigned a severity (Critical/High/
   Moderate/Low, CVSS-aligned) within 5 business days. See the remediation SLA
   table below for the deadlines that follow from that severity.
3. **Fix** — a patch is developed on a private branch/advisory so the issue is
   not publicly visible before a fix ships.
4. **Coordinated disclosure** — once a fix is released, the reporter is credited
   (with permission) in the GitHub Security Advisory and release notes. Public
   disclosure timing is coordinated with the reporter; the default is 90 days
   after the initial report or immediately after a fix ships, whichever is first.

---

## Dependency Vulnerability Management

### Automated scanning

| Tool | Trigger | Purpose |
|------|---------|---------|
| `npm audit` in CI | Every push / pull request | Blocks merge on **critical** or **high** findings |
| Weekly security workflow (`.github/workflows/security.yml`) | Every Monday 08:00 UTC | Full audit report; opens / updates a GitHub issue when critical/high vulns are found |
| Dependabot (`.github/dependabot.yml`) | Weekly (Monday) | Automatic PRs for patch and minor dependency updates |

### Severity thresholds

The CI pipeline uses `npm audit --audit-level=high`.  This means:

| Severity | CI behaviour |
|----------|-------------|
| **Critical** | ❌ Fails the build immediately |
| **High** | ❌ Fails the build immediately |
| **Moderate** | ⚠️ Reported in the audit output but does not fail the build |
| **Low** | ℹ️ Reported but does not fail the build |

### Remediation SLA by severity

The following timelines apply from the point at which a vulnerability is confirmed
(CVE published and affects a version we use):

| Severity | Target remediation | Maximum deadline |
|----------|--------------------|-----------------|
| **Critical** (CVSS ≥ 9.0) | Within **24 hours** | **3 days** |
| **High** (CVSS 7.0–8.9) | Within **3 days** | **7 days** |
| **Moderate** (CVSS 4.0–6.9) | Within **2 weeks** | **30 days** |
| **Low** (CVSS < 4.0) | Next scheduled dependency update | **90 days** |

If a fix is not available within the deadline (e.g. upstream has not yet released a
patch), the affected dependency must be temporarily replaced with a safe alternative
or its usage must be removed.  Any exception requires an explicit decision recorded
in a GitHub issue with the `security` label.

### Handling Dependabot PRs

1. **Patch updates** — grouped into a single weekly PR by Dependabot.  Merge after
   CI passes; no manual review required unless the package is security-sensitive.
2. **Minor updates** — review the changelog before merging.  Run the test suite
   locally if the package is a runtime dependency.
3. **Major updates** — open a separate tracking issue, plan the upgrade, and test
   thoroughly.  Do not merge automatically.
4. **Security advisories** — Dependabot will open a PR immediately outside the
   normal schedule.  Treat as Critical/High per the SLA table above.

### Manual remediation steps

```bash
# See all current vulnerabilities
npm audit

# Apply automatic patch-level fixes
npm audit fix

# See what would change without applying (dry run)
npm audit fix --dry-run

# Force a breaking-change fix (use with care — review changelog first)
npm audit fix --force
```

---

## Subresource Integrity (SRI)

Every `<script>` / `<link rel="stylesheet">` loaded from a third-party (non-same-origin)
host must carry an `integrity` (+ `crossorigin`) attribute, so a compromised CDN cannot
silently swap the file we serve to users.

- `scripts/check-sri.js` scans `index.html` (static tags) and `src/**/*.{ts,tsx}`
  (dynamically injected `script.src`/`link.href`, e.g. `src/hooks/useAnalytics.ts`) for
  cross-origin assets missing `integrity`.
- CI (`.github/workflows/ci.yml`) runs this check on every push/PR and fails the build
  on any unreviewed finding.
- **Exceptions** — some assets genuinely cannot carry a static hash (content negotiated
  per-User-Agent, or the vendor rebuilds the file on their own schedule). These are
  documented in [`sri-exceptions.json`](./sri-exceptions.json) with a `host`, `reason`,
  and `reviewBy` date. The check script warns when an exception's `reviewBy` date has
  passed so stale exceptions get re-evaluated instead of silently living forever.
  Add a new exception only when pinning is genuinely impossible, and prefer pinning
  wherever the vendor publishes versioned, immutable URLs.

## Dynamic Application Security Testing (DAST)

`.github/workflows/dast.yml` runs an [OWASP ZAP baseline scan](https://www.zaproxy.org/docs/docker/baseline-scan/)
against a locally served production build (`vite preview`) on every push to `main` and
on demand (`workflow_dispatch`). It exercises the app's real routes (dashboard, price
detail, API docs) against mock data, uploads the ZAP report as a downloadable CI
artifact, and fails the job on any **High**-severity alert. Known false positives for
this app (e.g. alerts about the intentionally strict CSP itself) are tuned out via
[`.zap/rules.tsv`](./.zap/rules.tsv) — treat additions to that file as security
decisions requiring review, not routine noise suppression.

## Content Security Policy reporting

The CSP in `vercel.json` sends violation reports to `/api/csp-report` (a small Vercel
serverless function, `api/csp-report.ts`) via the `report-to`/`Reporting-Endpoints`
headers, and the app additionally listens for the browser's `securitypolicyviolation`
event directly (`src/utils/cspReporting.ts`) so violations are visible even when no
report collector is configured. Captured violations feed the existing console
aggregator (so they show up alongside other warnings) and a dedicated
`CspViolationsPanel` component that surfaces the top violating directives and recent
blocked URIs.

**Report-only rollout per environment** — because Vercel resolves `vercel.json` from
the exact commit being deployed, the safe way to trial a policy change is:

1. Change the `Content-Security-Policy` header key to `Content-Security-Policy-Report-Only`
   in `vercel.json` on the `staging` branch only (this repo auto-deploys `staging` and
   `develop` as separate environments — see `.github/workflows/preview.yml`).
2. Let it run against real traffic; watch `CspViolationsPanel` / the `/api/csp-report`
   logs for the violating directives and blocked URIs.
3. Fix legitimate violations (loosen the specific directive, e.g. add a new CDN host to
   `connect-src`) or fix the code causing an unwanted violation.
4. Once the violation count is zero for a full traffic cycle, flip the header key back
   to `Content-Security-Policy` (enforced) and merge to `main`.

## Release provenance

Build artifacts published from `main` carry a [SLSA-style build provenance
attestation](https://slsa.dev/spec/v1.0/) generated by `actions/attest-build-provenance`
in `.github/workflows/release.yml`, signed via GitHub's OIDC identity for the workflow
run (no long-lived keys). The release job requests `id-token: write` and
`attestations: write` and runs the attestation step after the build, so consumers can
verify that a given artifact was produced by this repository's release workflow.
