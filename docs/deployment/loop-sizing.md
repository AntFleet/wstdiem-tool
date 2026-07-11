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

`--rate-at-target-apy-bps` is the AdaptiveCurveIrm rate at 90% utilization. Read it on-chain (≈217 bps as of 2026-07-11) or default to the Morpho genesis value of 400 bps (conservative). The report's `Util→Borrow APR` column shows each scenario's post-draw utilization and the resulting effective APR; the summary prints the curve reference points (`rateAtTarget @90% util`, `4× @100% util`).

Reproduce `rateAtTarget` from chain with `AdaptiveCurveIrm.borrowRateView(marketParams, market)`: the return at 90% utilization is `rateAtTarget`; at 100% it is `4 × rateAtTarget`.

## Model Limits

The simulator uses a conservative linear depth-share model for Curve, a simple supply-minus-existing-borrow model for Morpho liquidity, and the instantaneous Adaptive Curve rate for borrow cost. It is useful for sizing and blocker discovery, but it is not a substitute for a fork-backed `get_dy` proof or live readiness evidence.

The borrow model is **instantaneous**: it prices the rate at the loop's post-draw utilization for a supplied `rateAtTarget`, but does **not** model the multi-day `rateAtTarget` adaptation (it drifts up under sustained high utilization and down when idle). Pass the current on-chain `rateAtTarget`, and treat sustained-high-utilization scenarios as understated. APR is simple-annualized (not compounded), so effective APY is marginally higher.

Treat blocked scenarios as hard blockers for the given assumptions. Treat viable scenarios as candidates for deeper fork/live validation, not approval to broadcast.
```
