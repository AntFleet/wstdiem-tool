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
  --vault-apy-bps 1500 \
  --borrow-apy-bps 800
```

Use `--json` after `loop sizing` for a machine-readable report. Token-denominated values are serialized as integer strings.

## Model Limits

The first implementation uses a conservative linear depth-share model for Curve and a simple supply-minus-existing-borrow model for Morpho. This is useful for sizing and blocker discovery, but it is not a substitute for a fork-backed `get_dy` proof or live readiness evidence.

Treat blocked scenarios as hard blockers for the given assumptions. Treat viable scenarios as candidates for deeper fork/live validation, not approval to broadcast.
