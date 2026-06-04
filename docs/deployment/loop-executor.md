# LoopExecutor Deployment Checklist

This checklist is for the exit-only `LoopExecutor` deployment path. It is not an approval to enable broadcast. `loop readiness` must continue reporting `broadcastAvailable: false` and `auditRequired: true` until a later SPEC update explicitly clears the production audit gate.

## Inputs

Set these environment variables before a dry run:

```sh
export BASE_RPC_URL="https://..."
export LOOP_EXECUTOR_UNISWAP_V3_FACTORY="0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
export LOOP_EXECUTOR_UNISWAP_V3_POOL="0x80d995189ecc593672aD4703b250a5e82672EB1D"
export LOOP_EXECUTOR_LOAN_TOKEN="0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"
export LOOP_EXECUTOR_PAIR_TOKEN="0x4200000000000000000000000000000000000006"
export LOOP_EXECUTOR_UNISWAP_V3_FEE_TIER="10000"
export LOOP_EXECUTOR_MORPHO="0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
export LOOP_EXECUTOR_CURVE_POOL="0x39A4b4779C71E1A18d500627639682c9583Ee86f"
export LOOP_EXECUTOR_WSTDIEM="0x4751BA2b09374C1929FC01734a166e3c8cd75810"
```

## Dry Run

Run the deployment script against a Base fork without broadcasting:

```sh
npm run deploy:executor:dry-run
```

The dry run must construct `LoopExecutor` successfully. Constructor validation must reject zero addresses, non-contract protocol addresses, non-contract flash config addresses, same loan/pair token, mismatched factory/pool/fee-tier config, and missing canonical pool evidence.

## Required Validation

Before a production deploy is considered, all of these must pass:

```sh
npm run typecheck
npm test
npm run build
npm run test:contracts
BASE_RPC_URL="$BASE_RPC_URL" npm run test:contracts:fork:required
npm run deploy:executor:dry-run
git diff --check
```

The fork tests and dry run must prove:

- `canonicalFlashPool()` equals the configured Uniswap V3 DIEM/WETH pool.
- `expectedFlashFee(amount)` matches the configured fee tier.
- `loanTokenIsToken0()` matches the configured DIEM/WETH token ordering.
- deployed executor config matches the expected Uniswap V3, Morpho, Curve, and wstDIEM addresses.
- the executor retains zero DIEM and zero wstDIEM immediately after deployment.

## Production Gate

Do not run `forge script ... --broadcast` until all of these are true:

- final focused audit signoff is complete for the exact source, constructor inputs, and deployment command.
- Curve and Morpho live liquidity are populated enough for the intended full unwind.
- the owner position exists and is configured.
- the owner has authorized the executor in Morpho.
- `npm run readiness:owner` has been run with `WSTDIEM_FORK_LOOP_EXECUTOR` set to the deployed executor.
- the env-gated Base full-unwind fork proof has passed with owner, executor, and authorization configured.
- SPEC001 has been updated to clear the production audit gate.

## Post-Deploy Checks

After a deployment, record the deployed executor address and rerun readiness with the executor bound explicitly:

```sh
WSTDIEM_FORK_LOOP_EXECUTOR="<deployed-executor>" WSTDIEM_FORK_OWNER="<owner>" npm run readiness:owner
```

Readiness must still block broadcast until the production gate is explicitly cleared.
