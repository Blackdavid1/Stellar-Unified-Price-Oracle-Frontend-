import React from 'react';

/**
 * Reference-price oracle badge.
 *
 * The reference price is an independent benchmark source used ONLY for
 * evaluation (ground-truth cross-checks, bias alerts, strategy scoring).
 * It is never a tradable price and is excluded from the aggregate.
 *
 * This component labels the reference unambiguously as a benchmark so it
 * can never be mistaken for a display/tradable price.
 */

export interface ReferenceBenchmarkBadgeProps {
  /** Reference (benchmark) price value, if available. */
  referencePrice?: number | null;
  /** Aggregate price value, if available. */
  aggregatePrice?: number | null;
  /** ISO currency code for both prices. */
  currency?: string;
  /** Optional deviation (aggregate vs reference) as a fraction, e.g. 0.012 = 1.2%. */
  deviation?: number | null;
  /** Sustained-bias alert flag from the deviation tracker. */
  biasAlert?: boolean;
  /** Optional bias threshold (fraction) that triggered the alert. */
  biasThreshold?: number | null;
  /** Optional className passthrough. */
  className?: string;
}

function formatPrice(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatDeviation(deviation: number | null | undefined): string {
  if (deviation === null || deviation === undefined || !Number.isFinite(deviation)) {
    return '—';
  }
  const pct = deviation * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

const ReferenceBenchmarkBadge: React.FC<ReferenceBenchmarkBadgeProps> = ({
  referencePrice,
  aggregatePrice,
  currency,
  deviation,
  biasAlert = false,
  biasThreshold,
  className,
}) => {
  const hasReference =
    referencePrice !== null && referencePrice !== undefined && Number.isFinite(referencePrice);

  return (
    <div
      className={className}
      role="note"
      aria-label="Reference benchmark price (not tradable)"
      data-testid="reference-benchmark-badge"
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 12px',
        border: '1px dashed #8a8a8a',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 700,
            fontSize: 10,
            color: '#8a8a8a',
          }}
        >
          Benchmark
        </span>
        <span style={{ fontWeight: 600 }}>Reference price</span>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>
          <span style={{ color: '#8a8a8a' }}>Reference: </span>
          <span data-testid="reference-benchmark-value">
            {formatPrice(referencePrice, currency)}
          </span>
        </span>
        {aggregatePrice !== null && aggregatePrice !== undefined && (
          <span>
            <span style={{ color: '#8a8a8a' }}>Aggregate: </span>
            <span data-testid="reference-benchmark-aggregate">
              {formatPrice(aggregatePrice, currency)}
            </span>
          </span>
        )}
        {deviation !== null && deviation !== undefined && (
          <span>
            <span style={{ color: '#8a8a8a' }}>Deviation: </span>
            <span data-testid="reference-benchmark-deviation">
              {formatDeviation(deviation)}
            </span>
          </span>
        )}
      </div>

      <div style={{ color: '#8a8a8a', fontSize: 11 }}>
        Independent benchmark for evaluation only — not a tradable price and excluded from the
        aggregate.
      </div>

      {biasAlert && (
        <div
          role="alert"
          data-testid="reference-benchmark-bias-alert"
          style={{ color: '#b00020', fontWeight: 600, fontSize: 11 }}
        >
          Sustained bias detected vs reference
          {biasThreshold !== null && biasThreshold !== undefined
            ? ` (threshold ${(biasThreshold * 100).toFixed(2)}%)`
            : ''}
          .
        </div>
      )}

      {!hasReference && (
        <div style={{ color: '#8a8a8a', fontSize: 11 }}>Reference source unavailable.</div>
      )}
    </div>
  );
};

export default ReferenceBenchmarkBadge;
