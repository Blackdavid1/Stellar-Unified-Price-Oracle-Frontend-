/**
 * @file Governance types (community voting on oracle-source decisions).
 *
 * Every field here is reported by the governance API. Nothing on these types is
 * inferred, back-filled, or re-scaled client-side. That constraint is
 * deliberate: source-performance figures and vote tallies are political
 * ammunition in this project, so a dashboard that guesses a value is worse than
 * one that renders "unavailable" — the community will act on the number.
 */

/**
 * Lifecycle of a proposal, exactly as reported by the API.
 * The client never derives a status (e.g. by comparing `closesAt` to the local
 * clock); see `deriveProposalDeadline` in `utils/governance.ts` for how a
 * stale-but-still-active proposal is surfaced without rewriting its status.
 */
export type ProposalStatus = 'pending' | 'active' | 'passed' | 'rejected' | 'cancelled' | 'executed'

/** The vote options the governance contract tallies. */
export type VoteChoice = 'for' | 'against' | 'abstain'

/**
 * Raw vote counts as reported by the API, in voting-power units.
 * Counts are whole, non-negative integers and are never re-scaled client-side.
 */
export interface VoteTally {
  for: number
  against: number
  abstain: number
}

// ── #698 Transparent parameter registry ──────────────────────────────────────

/**
 * A single tuneable parameter managed by the registry.
 * All fields come verbatim from the API — the client never infers values.
 */
export interface ParameterEntry {
  /** Stable identifier for this parameter, e.g. `"oracle.weight.chainlink"`. */
  key: string
  /** Current value as a raw string (number, bool, or JSON-encoded object). */
  value: string
  /** Human-readable description of what the parameter controls. */
  description: string
  /** The team or role responsible for this parameter. */
  owner: string
  /** Unix timestamp (ms) when this value was last changed. */
  updatedAt: number
  /** Category grouping, e.g. `"thresholds"` | `"weights"` | `"timeouts"`. */
  category: string
}

/**
 * A single change-log entry for a parameter.
 * Ordered descending by `changedAt` (most recent first).
 */
export interface ParameterChangeLogEntry {
  /** The parameter key this entry refers to. */
  key: string
  /** Value before the change. */
  previousValue: string
  /** Value after the change. */
  nextValue: string
  /** Unix timestamp (ms) when the change was applied. */
  changedAt: number
  /** Actor who made the change (address, team name, or `"governance"`). */
  changedBy: string
  /** Human-readable rationale, or null when not provided. */
  reason: string | null
}

// ── #697 Reputation decay & sybil resistance ─────────────────────────────────

/**
 * Reputation metrics for a single oracle source.
 * The raw score from the API is never re-scaled client-side.
 */
export interface SourceReputation {
  /** Oracle source identifier, e.g. `"chainlink"`. */
  sourceId: string
  /** Current reputation score in [0, 1]. */
  score: number
  /** Effective score after decay applied by the registry. */
  decayedScore: number
  /**
   * Sybil resistance weight in [0, 1].
   * Low values indicate suspected duplicate or low-stake sources.
   */
  sybilResistanceWeight: number
  /** Unix timestamp (ms) of the last decay computation. */
  lastDecayAt: number
  /** Number of consecutive periods with no activity (drives accelerated decay). */
  inactivePeriods: number
}

// ── #696 Treasury & incentive accounting ─────────────────────────────────────

/**
 * Ledger entry for an oracle source operator.
 * Amounts are in the protocol's native unit (a string to avoid float drift).
 */
export interface TreasuryEntry {
  /** Oracle source identifier. */
  sourceId: string
  /** Cumulative rewards accrued, as a decimal string. */
  accruedRewards: string
  /** Cumulative rewards claimed, as a decimal string. */
  claimedRewards: string
  /**
   * Rewards pending the next settlement cycle, as a decimal string.
   * Null when the cycle has not yet been computed.
   */
  pendingRewards: string | null
  /** Uptime contribution score used in the last settlement, in [0, 1]. */
  uptimeScore: number
  /** Accuracy contribution score used in the last settlement, in [0, 1]. */
  accuracyScore: number
  /** Unix timestamp (ms) of the last settlement computation. */
  lastSettledAt: number | null
}

// ── #695 Dispute & challenge process ─────────────────────────────────────────

/** Lifecycle of a price dispute. */
export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'dismissed'

/** The outcome recorded when a dispute is closed. */
export type DisputeOutcome = 'upheld' | 'rejected' | 'inconclusive' | null

/**
 * A formal challenge to an aggregated price.
 * All fields are verbatim from the governance API.
 */
export interface PriceDispute {
  /** Stable identifier assigned at submission time. */
  id: string
  /** The asset pair being challenged, e.g. `"BTC/USD"`. */
  assetPair: string
  /** The disputed aggregated price. */
  disputedPrice: number
  /** Unix timestamp (ms) of the price tick being challenged. */
  priceTimestamp: number
  /** Current lifecycle status. */
  status: DisputeStatus
  /** Address or identifier of the party who raised the dispute. */
  challenger: string
  /** Human-readable description of the discrepancy observed. */
  reason: string
  /**
   * URL or CID pointing to attached evidence (chart exports, raw tick dumps).
   * Null when no evidence was attached.
   */
  evidenceUrl: string | null
  /** Unix timestamp (ms) when the dispute was submitted. */
  createdAt: number
  /** Unix timestamp (ms) when the dispute was closed, or null when still open. */
  resolvedAt: number | null
  /** Final outcome, or null while the dispute is still open. */
  outcome: DisputeOutcome
  /** Reviewer notes written when the dispute was closed. Null until resolved. */
  resolutionNotes: string | null
  /** Sources flagged by the challenger as contributing to the bad price. */
  flaggedSources: string[]
}

/** A single governance proposal the community can act on. */
export interface GovernanceProposal {
  /** Stable identifier assigned by the governance contract. */
  id: string
  title: string
  summary: string
  status: ProposalStatus
  /** Unix timestamp (ms) when voting opened. */
  createdAt: number
  /** Unix timestamp (ms) when voting closes, or null when the API reports no deadline. */
  closesAt: number | null
  /** Vote counts exactly as reported by the API. */
  tally: VoteTally
  /** Participating voting power required for the result to be valid, or null when unset. */
  quorum: number | null
  /** Total eligible voting power, or null when the API does not report it. */
  totalVotingPower: number | null
  /** Owning governance body or category, or null. */
  category: string | null
  /** Oracle sources this proposal concerns (add / remove / re-weight). */
  relatedSources: string[]
}
