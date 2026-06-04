# Production Audit Gate

The current implementation is audit-fixed and intentionally broadcast-disabled. This gate defines what must happen before any future SPEC update can allow production broadcast for `LoopExecutor`.

## Gate State

Current state: **closed**.

Required runtime behavior while closed:

- `loop readiness` reports `broadcastAvailable: false`.
- `loop readiness` reports `auditRequired: true`.
- `loop open`, `loop rebalance`, and `loop exit` do not broadcast production transactions.
- deployment work remains dry-run or fork-only unless the operator explicitly runs a reviewed broadcast command outside this repo's default scripts.

## Inputs Required To Clear

All of these inputs are required before this gate can be proposed for clearing:

- exact git commit hash for the reviewed source.
- exact `LoopExecutor` constructor inputs.
- exact deployer address and chain id.
- exact deployment command.
- final focused audit report covering the source, constructor inputs, deployment command, and production operating procedure.
- green validation evidence from the required command set in [loop-executor.md](./loop-executor.md).
- green strict live-readiness evidence for the deployed executor and owner. The reported readiness state must still show broadcast disabled while this gate is closed.
- green full-unwind fork proof with owner, executor, and Morpho authorization configured.

## Clearing Procedure

1. Freeze the reviewed commit. Do not edit Solidity, ABI, config schema, readiness, or deployment scripts after audit signoff without restarting this gate.
2. Run the full validation set from [loop-executor.md](./loop-executor.md).
3. Run strict live readiness with the deployed executor and owner:

   ```sh
   npm run readiness:owner
   ```

4. Run the required full-unwind fork proof:

   ```sh
   npm run proof:full-unwind
   ```

5. Record all command outputs, block numbers, owner address, executor address, and constructor inputs in an audit-gate evidence note.
6. Update `SPEC001.md` in a dedicated commit to explicitly clear or describe the production audit gate. The update must state whether broadcast remains blocked or which exact command surface is enabled.
7. Only after that SPEC update may a production broadcast path be implemented or enabled.

## Reclose Conditions

The gate is closed again if any of these change after signoff:

- `contracts/LoopExecutor.sol`
- `src/abi/loopExecutor.ts`
- `src/loop/readiness.ts`
- `src/loop/simulator.ts`
- `src/loop/exitPlan.ts`
- `script/DeployLoopExecutor.s.sol`
- constructor input addresses or fee tier
- owner authorization model
- selected flash-loan provider or pool

Any reclose requires a new focused review and fresh readiness/full-unwind evidence.
