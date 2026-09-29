# Security Policy

## Supported Versions

We provide security updates for the latest released minor version of the project.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < latest | :x:               |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than opening a
public issue. We aim to acknowledge reports within 3 business days and to provide
a remediation timeline after triage.

## Dependency Policy

This policy governs third-party dependencies and is enforced in CI. It covers
three areas: Software Bill of Materials (SBOM), license allow-listing, and a
severity-based upgrade SLA for known vulnerabilities.

### 1. Software Bill of Materials (SBOM)

An SBOM is generated for every release and attached to the release artifacts.

- Format: [CycloneDX](https://cyclonedx.org/) JSON (`sbom.cdx.json`).
- Generation: the release workflow runs the SBOM generator against the locked
  dependency tree and uploads the resulting file as a release asset alongside the
  build artifacts.
- The SBOM is produced from the committed lockfile so it reflects the exact
  dependency set that ships.

### 2. License Policy

Only dependencies under an approved license are permitted. The build fails when
a dependency resolves to a license that is not on the allow-list.

**Allowed licenses**

- MIT
- ISC
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- 0BSD
- CC0-1.0
- Unlicense

**Disallowed (non-exhaustive)**

- GPL-2.0, GPL-3.0, AGPL-3.0 and other copyleft licenses
- Any license not explicitly listed as allowed

Enforcement: CI runs a license check over the dependency tree and fails the
build on any disallowed or unrecognized license. New licenses must be added to
the allow-list (with review) before a dependency using them can be merged.

### 3. Severity-Based Upgrade SLA

Known vulnerabilities reported by the automated audit must be remediated within
the window defined by their severity. The audit issue enforces this mapping by
labeling each finding with its severity and due date.

| Severity | Remediation SLA |
| -------- | --------------- |
| Critical | 7 days          |
| High     | 14 days         |
| Moderate | 30 days         |
| Low      | 90 days         |

Findings past their SLA are treated as release blockers until remediated or
explicitly excepted (see below).

### 4. Exceptions

Exceptions to the license policy or the upgrade SLA must be recorded with an
owner and an expiry date, following the conventions established in
`sri-exceptions.json`.

Each exception entry records:

- `id` — stable identifier for the exception.
- `owner` — the individual or team accountable for resolving it.
- `expires` — ISO-8601 date after which the exception is no longer valid.
- `reason` — justification for the exception.
- `scope` — the dependency, license, or advisory the exception applies to.

Exceptions without an owner or an expiry date are invalid and will not be
honored by CI. Expired exceptions fail the build, forcing re-review.

## Third-Party Origin Policy

This policy governs every external origin (scripts, styles, fonts, images, and
API endpoints) referenced by the application. It is enforced in CI and is the
single source of truth for which external origins are approved.

### 1. Central Origin Allow-List

All external origins are inventoried in a central allow-list registry. Each
entry records:

- `origin` — the scheme and host (and port, when non-default) of the external
  origin, e.g. `https://fonts.googleapis.com`.
- `purpose` — why the origin is needed and what asset(s) it serves.
- `owner` — the individual or team accountable for the origin.
- `reviewed` — ISO-8601 date of the most recent review.
- `nextReview` — ISO-8601 date by which the entry must be reviewed again.

An origin that is not present in the registry is not approved. Adding a new
external origin requires a registry entry with an owner and a review date before
it can be merged.

### 2. Pinning and Subresource Integrity (SRI)

Every external asset must be pinned and integrity-checked:

- Scripts and stylesheets loaded from an external origin must carry a
  `integrity` attribute with a valid SRI hash and a `crossorigin` attribute.
- Versioned asset URLs must be pinned to an exact version (no floating ranges
  such as `latest` or unversioned paths).
- Fonts and other subresources must be served from an allow-listed origin and
  pinned to an exact version.

Enforcement: CI scans the codebase for external asset references and fails the
build when any external asset lacks a valid SRI hash or an exact version pin.

### 3. CSP / Allow-List Cross-Check

The Content Security Policy (see the CSP triage runbook) must match the origin
allow-list exactly:

- Every origin referenced in code must appear in the CSP directives
  (`script-src`, `style-src`, `font-src`, `img-src`, `connect-src`, etc.).
- Every origin present in the CSP must have a corresponding allow-list entry.

Enforcement: CI cross-checks the CSP against the registry and fails the build on
any mismatch in either direction — an origin in code but missing from the CSP, or
an origin in the CSP but missing from the allow-list.

### 4. Review Cadence

The origin allow-list is reviewed on a schedule:

- Each entry carries a `nextReview` date; entries are reviewed at least every
  90 days.
- The review confirms the origin is still required, its owner is current, and its
  pin/SRI hashes are up to date.
- Entries past their `nextReview` date are flagged and treated as release
  blockers until re-reviewed or removed.

Exceptions to this policy must be recorded with an owner and an expiry date,
following the conventions established in `sri-exceptions.json`.
