# Live Readiness And Full-Unwind Proof

Use this runbook after a candidate executor is deployed or identified. It does not enable broadcast; it only collects evidence for the closed production audit gate.

## Required Environment

```sh
export BASE_RPC_URL="https://..."
export WSTDIEM_FORK_LOOP_EXECUTOR="0x..."
export WSTDIEM_FORK_OWNER="0x..."
```

Optional overrides for alternate deployments:

```sh
export WSTDIEM_FORK_INFERENCE_VAULT="0x..."
export WSTDIEM_FORK_CURVE_POOL="0x..."
export WSTDIEM_FORK_MORPHO_ORACLE="0x..."
export WSTDIEM_FORK_MARKET_ID="0x..."
```

## Config Requirements

The CLI config used for readiness must include:

- `rpc.primaryUrl: ${BASE_RPC_URL}`
- configured Base DIEM, wstDIEM, Curve pool, Morpho Blue, Morpho oracle, market id, and Uniswap V3 flash-provider fields matching `config.example.yaml`.

The owner and executor candidate are bound by the evidence command itself:

- `WSTDIEM_FORK_LOOP_EXECUTOR` is passed as `--loop-executor`.
- `WSTDIEM_FORK_OWNER` is passed as `--owner`.
- both must be valid nonzero EVM addresses.

## Readiness

Run:

```sh
npm run readiness:owner
```

The script validates the live evidence env, rebuilds `dist`, then passes `WSTDIEM_FORK_OWNER` as `--owner` and `WSTDIEM_FORK_LOOP_EXECUTOR` as `--loop-executor`, so a deployed executor candidate can be checked without permanently editing the local config.

Expected result before the production gate is cleared:

- Curve liquidity check passes only when live Curve DIEM and wstDIEM balances are nonzero.
- Morpho market liquidity passes only when live DIEM supply exists.
- owner position passes only when the owner has wstDIEM collateral and DIEM debt.
- Morpho authorization passes only when the owner has authorized the configured executor.
- executor config passes only when `canonicalFlashPool()`, `expectedFlashFee(50 DIEM)`, `loanTokenIsToken0()`, `flashConfig()`, and `protocolConfig()` match the configured Uniswap V3, Morpho, Curve, and wstDIEM evidence.
- audit gate still fails and keeps broadcast disabled.

## Full-Unwind Fork Proof

Run:

```sh
npm run proof:full-unwind
```

This command is stricter than `npm run test:contracts:fork`: it fails immediately if `BASE_RPC_URL`, `WSTDIEM_FORK_LOOP_EXECUTOR`, or `WSTDIEM_FORK_OWNER` are missing, malformed, or zero, so the full-unwind readiness test cannot silently no-op.

The proof must establish:

- configured vault, Curve pool, Morpho oracle, and Morpho market are live contracts.
- Curve has nonzero DIEM and wstDIEM balances and can quote wstDIEM to DIEM.
- executor runtime config matches the selected Uniswap V3 DIEM/WETH 1% provider and the expected Morpho, Curve, and wstDIEM protocol addresses.
- owner has nonzero Morpho borrow shares and collateral.
- owner has authorized the executor in Morpho.

If any check fails, production deployment remains blocked.
