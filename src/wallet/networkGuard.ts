/**
 * Wallet network pinning (#632): the wallet's live network passphrase must match
 * the app's configured network before every signature.
 */
import { getFreighterNetwork, WalletError } from './freighterClient'
import { getActiveNetwork } from '../lib/onChainClient'
import { NETWORK_PASSPHRASES, networkFromPassphrase } from '../lib/networkRegistry'
import type { OracleNetwork } from '../lib/contractRegistry'
import type { PriceProof } from '../types/onChainPrice'

export interface NetworkCheck {
  ok: boolean
  expected: OracleNetwork
  /** Network the wallet is on, or null when the passphrase is unrecognised. */
  actual: OracleNetwork | null
  walletPassphrase: string
  message?: string
}

/** Pure comparison of the wallet passphrase against the expected app network. */
export function checkNetwork(expected: OracleNetwork, walletPassphrase: string): NetworkCheck {
  const actual = networkFromPassphrase(walletPassphrase)
  if (walletPassphrase === NETWORK_PASSPHRASES[expected]) {
    return { ok: true, expected, actual, walletPassphrase }
  }
  const got = actual ?? `an unknown network ("${walletPassphrase}")`
  return {
    ok: false,
    expected,
    actual,
    walletPassphrase,
    message: `Wrong network: this app is on ${expected} but your wallet is on ${got}. Switch your wallet to ${expected} (Freighter > Settings > Network), or switch the app network in developer settings, then try again.`,
  }
}

/** Reads the wallet's network now and throws a `wrong-network` WalletError on mismatch. Returns the passphrase. */
export async function assertWalletOnAppNetwork(expected: OracleNetwork = getActiveNetwork()): Promise<string> {
  const { networkPassphrase } = await getFreighterNetwork()
  const res = checkNetwork(expected, networkPassphrase)
  if (!res.ok) throw new WalletError('wrong-network', res.message ?? 'Wrong network.')
  return networkPassphrase
}

/** Ensures a verification record carries the network passphrase it was recorded against. */
export function stampProofNetwork<T extends PriceProof | null | undefined>(proof: T): T {
  if (!proof || proof.networkPassphrase) return proof
  const passphrase = NETWORK_PASSPHRASES[proof.network]
  return { ...proof, networkPassphrase: passphrase }
}
