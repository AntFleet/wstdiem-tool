# Loop Sizing Simulator

`loop sizing` is an offline advisory simulator for estimating whether a DIEM/wstDIEM loop size is economically viable before any live operator action.

It does not use RPC, does not broadcast, does not deploy an executor, and does not clear the audit gate. Production readiness still requires live Curve liquidity, Morpho market liquidity, a funded owner position, executor deployment and authorization, evidence runs, and final audit signoff.

## Example

```sh
npm run build
node dist/cli/index.js loop sizing \
  --initial-diem 100 \
  --target-leverage 1.5,2,3 \
  --curve-depth-diem 0,1000,10000 \
  --morpho-supply-diem 0,1000,10000 \
  --morpho-existing-borrow-diem 2.5 \
  --vault-apy-bps 1500 \
  --rate-at-target-apy-bps 217
```

Use `--json` after `loop sizing` for a machine-readable report. Token-denominated values are serialized as integer strings.

## Borrow-rate model (utilization-aware)

Borrow cost is **not** a constant. The Morpho wstDIEM/DIEM market uses an Adaptive Curve IRM whose borrow rate is `curve(utilization) × rateAtTarget`, where the multiplier is pinned at 0.25× (0% util), 1× (90% target util), and 4× (100% util). A loop's own borrow pushes utilization up, so the rate it pays depends on the size of its draw relative to the pool — a shallow pool that reads ~1% APR while idle can cost ~4× `rateAtTarget` once a loop consumes it.

Two models are available via `--borrow-rate-model`:

- **`adaptive-curve` (default).** Derives the effective borrow APR from each scenario's **post-draw utilization** = `(existing borrow + this loop's borrow) / supply`, using `--rate-at-target-apy-bps` as the anchor. This is the honest model: it prices the rate the loop actually creates, not a fixed assumption.
- **`flat`.** Uses `--borrow-apy-bps` verbatim (legacy). Only sweep `--borrow-apy-bps` in this mode.

`--rate-at-target-apy-bps` is the AdaptiveCurveIrm rate at 90% utilization. The default `400` is the conservative Morpho-genesis value — deliberately pessimistic (~2× the ~217 bps live rate as of 2026-07-11), because a *higher* assumed borrow rate understates net APY and blocks more, never less, which is the safe error direction for a sizing tool that must not green-light a bad loop. Pass the live value (`--rate-at-target-apy-bps 217`) or `--from-chain` (which seeds it directly from chain) for realistic sizing. The report's `Util→Borrow APR` column shows each scenario's post-draw utilization and the resulting effective APR; the summary prints the curve reference points (`rateAtTarget @90% util`, `4× @100% util`).

Reproduce `rateAtTarget` from chain by calling `AdaptiveCurveIrm.rateAtTarget(marketId)` directly (an `int256` per-second WAD; annualize to bps). This is the exact read `--from-chain` uses below.

## Live seeding (`--from-chain`)

`loop sizing --from-chain` replaces guessed inputs with live Base reads, all pinned to one block: the Morpho `rateAtTarget` anchor, Morpho supply / existing-borrow, the two Curve legs, a direction-correct `get_dy` exit-slippage quote per scenario, and the vault APY from the rolling 7-day window. It **upgrades the inputs, not the model** — every Model Limit below still applies — and it never broadcasts.

```sh
export BASE_RPC_URL="https://..."      # a Base mainnet RPC
node dist/cli/index.js loop sizing --from-chain --initial-diem 100 --target-leverage 1.5,2
```

Add `--planning-block <n>` to pin the reads to a specific block instead of `latest`. An explicit flag always overrides its seed (e.g. `--morpho-supply-diem 100,1000` sweeps that dimension instead of seeding it).

### Fail-closed: it refuses to seed rather than seed garbage

`--from-chain` emits **no report** and exits non-zero when a seed cannot be trusted. The live example today is the **drained Curve pool**: the DIEM/wstDIEM pool (`0x21c33a1B…`) currently holds zero on both legs, so the default command fails closed:

```
FROM_CHAIN_SEED_BLOCKED: Curve pool has zero DIEM and wstDIEM depth; cannot seed an empty pool
```

This is intended — you cannot size a loop's exit against an empty pool, and the tool will not invent depth. Other fail-closed triggers: RPC unavailable, `chainId ≠ 8453`, `marketId` unset, any seed read reverting, a zero or codeless contract address, `rateAtTarget` read as 0 (uninitialized IRM), or Morpho `totalSupplyAssets == 0`.

**To rehearse against a drained pool anyway** (hypothetical depth), supply the Curve legs explicitly. This marks the curve dimension as operator-supplied, skips Curve chain-seeding and the live `get_dy` quote, and still seeds `rateAtTarget` and Morpho from chain:

```sh
node dist/cli/index.js loop sizing --from-chain \
  --curve-diem-leg 5000 --curve-wstdiem-leg 5000 \
  --initial-diem 100 --target-leverage 1.5
```

### Demotion: a degraded seed downgrades the verdict, it does not fail

A non-fatal missing seed does **not** stop the report — it demotes it. The verdict token degrades (e.g. `viable` → `candidate — unverified seed`), an `UNVERIFIED SEED` banner prints, and `authoritative` is `false` in the JSON envelope. This fires when:

- the **vault APY is not chain-measured** — on a fresh checkout the 7-day DB window has no history, so the vault APY falls back to `--vault-apy-bps` / the default (never 0) and the verdict is demoted (`vaultApySource: not-seeded`). It becomes authoritative once the keeper's `monitor` runs have accumulated ≥7 days of vault samples;
- the live `get_dy` exit quote is unavailable, or the Curve pool is more than ~2:1 imbalanced;
- an explicit `--vault-apy-bps` is supplied (an operator-typed APY is not chain-measured).

A JSON consumer must AND-combine each `results[].status` with the top-level `authoritative`: a `viable` under `authoritative: false` is a candidate, not a pass.

## Model Limits

The simulator uses a conservative linear depth-share model for Curve, a simple supply-minus-existing-borrow model for Morpho liquidity, and the instantaneous Adaptive Curve rate for borrow cost. It is useful for sizing and blocker discovery, but it is not a substitute for a fork-backed `get_dy` proof or live readiness evidence.

The borrow model is **instantaneous**: it prices the rate at the loop's post-draw utilization for a supplied `rateAtTarget`, but does **not** model the multi-day `rateAtTarget` adaptation (it drifts up under sustained high utilization and down when idle). Pass the current on-chain `rateAtTarget`, and treat sustained-high-utilization scenarios as understated. APR is simple-annualized (not compounded), so effective APY is marginally higher.

Treat blocked scenarios as hard blockers for the given assumptions. Treat viable scenarios as candidates for deeper fork/live validation, not approval to broadcast.
