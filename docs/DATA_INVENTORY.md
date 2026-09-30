# Data Inventory and Retention

This document enumerates every field persisted by the application, where it is
stored, why it is stored, its sensitivity, how long it is retained, and how a
user can delete it. It is the authoritative inventory referenced by the privacy
surface and by the automated inventory test.

## Deletion paths

- **`clearAllData()`** — the single user-facing "delete everything" entry point.
  It must remove every key listed below across `localStorage`, `sessionStorage`,
  and IndexedDB.
- **Per-store deletion** — individual stores expose their own clear/remove
  helpers (e.g. `clearIncidents()`, `clearAnalytics()`).
- **Retention enforcement** — time-series, incident, and analytics records are
  pruned automatically once they exceed their retention window.

## localStorage / sessionStorage

| Key | Store | Purpose | Sensitivity | Retention | Deletion path |
| --- | --- | --- | --- | --- | --- |
| `app_settings` | localStorage | User preferences and feature toggles | Low | Until user clears | `clearAllData()` |
| `auth_token` | localStorage | Session authentication token | **High** | Until logout / clear | `clearAllData()`, logout |
| `user_profile` | localStorage | Cached profile for offline display | Medium (PII) | Until user clears | `clearAllData()` |
| `theme` | localStorage | Selected UI theme | Low | Until user clears | `clearAllData()` |
| `locale` | localStorage | Selected language | Low | Until user clears | `clearAllData()` |
| `onboarding_state` | localStorage | Tracks completed onboarding steps | Low | Until user clears | `clearAllData()` |
| `feature_flags` | localStorage | Cached remote feature flags | Low | Until user clears | `clearAllData()` |
| `last_sync_at` | localStorage | Timestamp of last successful sync | Low | Until user clears | `clearAllData()` |
| `draft_incident` | sessionStorage | In-progress incident draft | Medium | Session end / clear | `clearAllData()` |
| `csp_violations` | localStorage | Buffered CSP violation reports | Medium | 7 days (retention) | `clearAllData()`, retention prune |

## IndexedDB

| Store | Purpose | Sensitivity | Retention | Deletion path |
| --- | --- | --- | --- | --- |
| `incidents` | Incident records and timeline | Medium | 90 days | `clearAllData()`, `clearIncidents()`, retention prune |
| `analytics` | Aggregated usage analytics | Medium | 30 days | `clearAllData()`, `clearAnalytics()`, retention prune |
| `time_series` | Time-series metric samples | Low | 30 days | `clearAllData()`, retention prune |
| `audit_log` | Security-relevant audit events | **High** | 180 days | `clearAllData()`, retention prune |
| `cache` | Generic response cache | Low | 24 hours | `clearAllData()`, retention prune |
| `migrations` | Applied schema migration markers | Low | Until clear | `clearAllData()` |

## Memory

| Field | Purpose | Sensitivity | Retention | Deletion path |
| --- | --- | --- | --- | --- |
| In-memory app state | Runtime UI state | Varies | Page unload | Reload / `clearAllData()` |
| In-memory caches | Request/derived caches | Low | Page unload | Reload / `clearAllData()` |

## Retention enforcement

Time-series, incident, and analytics data are pruned on write and on startup
using the retention windows above. Records older than their window are removed
from IndexedDB so that stale data does not accumulate indefinitely.

## Verification

The automated inventory test (`dataInventory.test.ts`) asserts that every key
present in `localStorage`/`sessionStorage` and every IndexedDB store is listed in
this inventory. The test fails when a stored key is missing from the inventory,
and it verifies that `clearAllData()` removes every listed key.

## Privacy surface

This inventory is linked from the in-app privacy surface so users can see what
is stored and how to delete it.
