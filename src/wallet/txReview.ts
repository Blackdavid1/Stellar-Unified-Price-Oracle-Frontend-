/**
 * Transaction review (#631): decode the exact XDR that will be signed, enforce an
 * op allow-list and fee ceiling, and diff against the operation the UI intended.
 */
import { Address, FeeBumpTransaction, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk'

export const ALLOWED_OP_TYPES = ['payment', 'invokeHostFunction'] as const
/** Default fee ceiling: 0.1 XLM in stroops. */
export const DEFAULT_MAX_FEE_STROOPS = 1_000_000

export interface DecodedOperation {
  type: string
  source?: string
  destination?: string
  asset?: string
  amount?: string
  contractId?: string
  functionName?: string
}

export interface TxSummary {
  source: string
  networkPassphrase: string
  feeStroops: number
  feeXlm: string
  operations: DecodedOperation[]
}

/** What the UI believes it is submitting. Only provided fields are compared. */
export interface IntendedOperation {
  type: string
  destination?: string
  asset?: string
  amount?: string
  contractId?: string
  functionName?: string
}

export type ReviewCode = 'decode-failed' | 'disallowed-op' | 'intent-mismatch' | 'fee-unavailable' | 'fee-too-high'

export class TxReviewError extends Error {
  code: ReviewCode
  constructor(code: ReviewCode, message: string) {
    super(message)
    this.name = 'TxReviewError'
    this.code = code
  }
}

export interface ReviewOptions {
  intended?: IntendedOperation[]
  maxFeeStroops?: number
  allowedOps?: readonly string[]
}

function decodeOp(op: Record<string, unknown>): DecodedOperation {
  const out: DecodedOperation = { type: String(op.type), source: op.source as string | undefined }
  if (op.type === 'payment') {
    const a = op.asset as { isNative(): boolean; code: string; issuer: string }
    out.destination = op.destination as string
    out.amount = op.amount as string
    out.asset = a.isNative() ? 'XLM' : `${a.code}:${a.issuer}`
  } else if (op.type === 'invokeHostFunction') {
    try {
      const inv = (op.func as { invokeContract(): { contractAddress(): never; functionName(): { toString(): string } } }).invokeContract()
      out.contractId = Address.fromScAddress(inv.contractAddress()).toString()
      out.functionName = inv.functionName().toString()
    } catch {
      /* not an invokeContract host function; type alone is shown */
    }
  }
  return out
}

/** Decodes an XDR envelope into a human-readable summary. */
export function decodeTransaction(xdr: string, networkPassphrase: string): TxSummary {
  let tx: Transaction | FeeBumpTransaction
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  } catch (e) {
    throw new TxReviewError('decode-failed', `Could not decode the transaction: ${e instanceof Error ? e.message : String(e)}`)
  }
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx
  const feeStroops = Number(tx.fee)
  return {
    source: inner.source,
    networkPassphrase,
    feeStroops,
    feeXlm: (feeStroops / 1e7).toFixed(7),
    operations: inner.operations.map((o) => decodeOp(o as unknown as Record<string, unknown>)),
  }
}

/** Throws a {@link TxReviewError} unless the summary passes allow-list, fee and intent checks. */
export function validateSummary(summary: TxSummary, opts: ReviewOptions = {}): void {
  const allowed = opts.allowedOps ?? ALLOWED_OP_TYPES
  const max = opts.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS
  for (const op of summary.operations) {
    if (!allowed.includes(op.type)) {
      throw new TxReviewError('disallowed-op', `Refusing to sign: operation type "${op.type}" is not on the allow-list (${allowed.join(', ')}).`)
    }
  }
  if (!Number.isFinite(summary.feeStroops) || summary.feeStroops <= 0) {
    throw new TxReviewError('fee-unavailable', 'Refusing to sign: the transaction fee could not be estimated.')
  }
  if (summary.feeStroops > max) {
    throw new TxReviewError('fee-too-high', `Refusing to sign: fee ${summary.feeStroops} stroops exceeds the ceiling of ${max}.`)
  }
  if (opts.intended) {
    const ops = summary.operations
    if (ops.length !== opts.intended.length) {
      throw new TxReviewError('intent-mismatch', `Transaction has ${ops.length} operation(s) but the app intended ${opts.intended.length}.`)
    }
    opts.intended.forEach((want, i) => {
      for (const k of Object.keys(want) as (keyof IntendedOperation)[]) {
        if (want[k] !== undefined && want[k] !== ops[i][k]) {
          throw new TxReviewError('intent-mismatch', `Operation ${i + 1} differs from what the app intended: ${k} is "${String(ops[i][k])}", expected "${want[k]}".`)
        }
      }
    })
  }
}

/** Decode + validate in one step. */
export function reviewTransaction(xdr: string, networkPassphrase: string, opts: ReviewOptions = {}): TxSummary {
  const summary = decodeTransaction(xdr, networkPassphrase)
  validateSummary(summary, opts)
  return summary
}
