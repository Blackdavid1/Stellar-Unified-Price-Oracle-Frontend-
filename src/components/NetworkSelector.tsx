import { useState } from 'react'
import { ORACLE_NETWORKS, type OracleNetwork } from '../lib/contractRegistry'
import { getActiveNetwork } from '../lib/onChainClient'
import { isNetworkSwitchEnabled, setSelectedNetwork } from '../lib/networkRegistry'

/** Developer-only network selector (#633). Renders nothing unless the dev flag is on. */
export function NetworkSelector({ onChange }: { onChange?: (n: OracleNetwork) => void }) {
  const [value, setValue] = useState<OracleNetwork>(getActiveNetwork())
  if (!isNetworkSwitchEnabled()) return null
  return (
    <label>
      Network{' '}
      <select
        value={value}
        onChange={(e) => {
          const n = e.target.value as OracleNetwork
          setValue(n)
          setSelectedNetwork(n)
          onChange?.(n)
        }}
      >
        {ORACLE_NETWORKS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  )
}
