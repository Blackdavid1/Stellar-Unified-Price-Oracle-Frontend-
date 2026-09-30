# Data-Quality Incident Postmortems

This document describes how data-quality incidents are captured, stored, replayed,
and expired. It is the reference for the automated replayable incident snapshots
feature (issue #668).

## Overview

When quality degrades (a source misbehaves, a spike is wrong), the evidence is
otherwise ephemeral: by the time anyone investigates, the ticks are gone and the
incident cannot be reproduced. To fix this, a quality incident trigger captures a
**bounded, replayable snapshot** of the relevant state and stores it in a format
that the test harness (#609) can drive deterministically.

## What a snapshot captures

On a quality incident trigger, the snapshot captures a bounded set of evidence:

- **Recent ticks** — a bounded window of the most recent ticks (not the full
  history), so the snapshot stays small and replayable.
- **Aggregate state** — the aggregate/quality state at the moment of the trigger.
- **Strategy config** — the strategy configuration in effect when the incident
  fired, so replay uses the same parameters.
- **Exclusions** — the exclusions (ignored sources, suppressed rules, etc.) that
  were active, so replay does not diverge from the original run.

All four are captured together so the incident is self-contained.

## Replayable format

The snapshot is stored in a replayable format that the test harness (#609) can
drive. The format is deterministic: given the same snapshot, the harness produces
the same result every time. This means:

- The snapshot records the inputs (ticks, aggregate state, strategy config,
  exclusions) rather than derived outputs.
- Replay is driven by the harness, which feeds the recorded inputs back through
  the same pipeline.
- No wall-clock time, random seeds, or external state are read during replay;
  everything needed is inside the snapshot.

## Incident view

An incident view renders the incident timeline together with the contributing
sources. The timeline shows the sequence of events leading up to and following the
trigger, and the contributing sources identify which sources (or rules) produced
the degraded quality. This lets an investigator see *what happened* and *who
contributed* without re-running the live system.

## Retention and expiry

Snapshots auto-expire. Retention is bounded and documented here so operators know
how long evidence is available:

- Snapshots are retained for a fixed, documented retention window.
- Expiry is enforced automatically; expired snapshots are removed.
- Retention is intentionally bounded to keep storage predictable and to avoid
  retaining stale evidence indefinitely.

## Acceptance criteria

- [x] Incident trigger captures a bounded, replayable snapshot
- [x] Snapshot replays deterministically in the harness
- [x] Incident view shows the timeline and contributing sources
- [x] Retention/expiry is enforced
