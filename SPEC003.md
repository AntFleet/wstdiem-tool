# SPEC003 — Loop sizing: live on-chain seeding (`loop sizing --from-chain`)

> **Forward spec** (authored before implementation; acceptance criteria = the tests to write).
> **Conforms to [`SPEC002.md`](SPEC002.md).** **Staged** by risk: **Part A ships now**; **Part B is
> gated behind a SPEC002 rev-2** (leg-aware/`get_dy` slippage + gas/MEV). Revised after a two-agent
> review gate (adversarial technical + product) that returned REVISE; the fixes are folded in below.

## 1. Purpose, scope & staging

`loop sizing --from-chain` removes garbage-in by seeding sizing inputs from live Base reads. **It
upgrades inputs, not the model** — every SPEC002 §8 limitation stands; a chain-seed is never "now the
numbers are real." Broadcast stays disabled (SPEC001).

**Staging rationale (from the review).** The five seeds split by risk:

- **Part A — safe (ship-ready):** `rateAtTargetApyBps`, `morphoSupplyDiem`, `morphoExistingBorrowDiem`.
  These feed the terms SPEC002 models to wei precision. Seeding them is pure garbage-in removal — and
  the headline win: SPEC002's default `rateAtTarget = 400` is ~2× the live ~217 bps.
- **Part B — soft (GATED):** `curveDepthDiem` and `vaultApyBps`. These feed the model's softest,
  verdict-flipping inputs — curve depth drives SPEC002 §5's *primary* exit-slippage gate; vault APY is
  the leverage-amplified `netApy` term. Seeding them into **today's** model just makes a still-unsafe
  `viable` look authoritative. Part B is blocked until **SPEC002 rev-2** (§4.1) lets the model consume
  them without over-selling.

## 2. Shared mechanics (both parts)

- **Block-pinning (on-chain reads only).** Read the target block once (`latest`, or `--planning-block
  <n>`) and pin **every on-chain seed read** to it. Part B's `vaultApyBps` is a 7-day **DB** window,
  **not** a single-block read — it is explicitly exempt from block-pinning (and from §8 criterion 8).
- **RPC discipline.** Reuse `selectBestRpcEndpoint` (`src/contracts/rpc.ts`) for **endpoint failover
  selection only** — it is single-best-by-liveness, **not** a quorum client. From the selected URL,
  construct a **`latest`-pinned** read client (rpc.ts's own selection reads `blockTag: "finalized"`,
  which lags head far past any useful staleness gate — do **not** pin seeds to finalized). Staleness:
  reject if the pinned block is > threshold behind head (concrete value: Open Question 1).
- **Fail-closed, no partial report.** RPC unavailable / `chainId ≠ 8453` / `marketId` null / any seed
  read reverts / an implausible value (per-seed guards below) → the command errors and emits no report.
- **Config plumbing.** `--from-chain` is `loop sizing`'s **first** RPC dependency (`sizing.ts` /
  `sizingScenarios.ts` are pure-offline today). It reuses the `client` + `planningBlock` pattern from
  `preflight.ts` / `readiness.ts` and adds address validation (nonzero + has-code; `marketId` non-null;
  `chainId == 8453`). This is a thin integration, **not** free reader-reuse — see §3/§4 for the exact
  export/adapter work each seed needs.
- **Verdict integrity (central rule, §6).** Any degraded or unseeded input sets `authoritative: false`
  and **demotes the verdict token itself** — not just a `warnings[]` sidecar.

## 3. Part A — safe seeds (ship-ready)

### 3.1 `rateAtTargetApyBps` ← direct read

Read `rateAtTarget(marketId)` **directly** from the AdaptiveCurveIrm (`int256`, per-second WAD) and
convert with `perSecWadToAprBps` (`src/loop/morphoRate.ts`). Requires **adding `rateAtTarget` to
`src/abi/morphoIrm.ts`** (today it holds only `borrowRateView`).

> Verified 2026-07-11 (IRM `0x4641…2687`, market `0xdd6b…6c76`): `rateAtTarget = 686605546` per-second
> WAD, and **`perSecWadToAprBps(686605546) === 217`** (integer bps).

- **`rateAtTarget == 0` (uninitialized IRM: the mapping is 0 until the market's first rate accrual)
  → fail-closed, NOT clamped.** The `[MORPHO_MIN…=10, MORPHO_MAX…=20000]` clamp must never absorb a
  zero read (that would silently seed 0.1% APR and inflate `netApy` toward `viable`). On zero: error,
  or fall back to the genesis 400 bps default with `rateAtTargetSource: "uninitialized-default"` and
  `authoritative: false`.
- **On a direct-read revert → fail-closed** (throw, no report). The inversion fallback
  (`borrowRateView ÷ curveMultiplierWad`) is **deferred out of Part A**: the direct read is the robust
  path this spec exists to use, and adding a fragile, ill-conditioned inversion for an edge that
  already fails safe is not worth it. (If ever revived, it belongs in a later revision with its own
  `inverted` / `inverted-ill-conditioned` source + low-util warning.) Clamp **non-zero** direct reads
  to `[10, 20000]` bps.

### 3.2 `morphoSupplyDiem` / `morphoExistingBorrowDiem` ← market read

`Morpho.market(marketId).totalSupplyAssets` / `.totalBorrowAssets`. Reuse `readMorphoMarket` — which
**must be exported** (`src/loop/preflight.ts:518` is module-private today) or extracted into a shared
helper (readiness re-inlines the same `market` read). Guard: `totalSupplyAssets == 0` → fail-closed
(cannot size against an empty market).

### 3.3 Flat-model interaction

Part A seeds the **adaptive** `rateAtTargetApyBps`. Under `--borrow-rate-model flat` the model instead
uses `borrowApyBps` (default 800; `sizing.ts:262`), which Part A does **not** seed — so a naive
`--from-chain --borrow-rate-model flat` would print a "seeded from block N" report on a **defaulted**
borrow rate. Resolution: **error** — *"`--from-chain` seeds the adaptive rate; pass `--borrow-apy-bps`
for the flat model."* (Provenance would otherwise misrepresent the borrow side.)

## 4. Part B — soft seeds (GATED behind SPEC002 rev-2)

> **Do not implement Part B until SPEC002 rev-2 (§4.1) ships.** Seeding these into the current model
> over-sells `viable` on exactly the pool/leverage the tool exists to guard.

### 4.1 Prerequisite — SPEC002 rev-2 model fixes

- **Leg-aware / `get_dy` exit slippage.** SPEC002's exit-slippage gate (its *primary* safety
  constraint) must consume a **convex, direction-correct `get_dy` quote** at the planned trade size —
  not the single-scalar linear `fee + trade/depth`. The `get_dy` reader already exists (SPEC001 §1).
  This is the correct layer for the imbalance fix, replacing the seed-layer `2×min` heuristic.
- **Gas + MEV.** `oneTimeCostDiem` gains a gas line (`--gas-cost-diem`) + MEV caveat (SPEC002 §11) —
  otherwise gas alone can flip a small-position `viable` negative.

### 4.2 `curveDepthDiem` ← live `get_dy` (once rev-2 lands)

With leg-aware slippage in the model, `--from-chain` seeds the exit-slippage input from a live
`get_dy(1→0, plannedExitSize)` at the pinned block — direction-correct and convex. It still reads both
legs (`balances(0)` DIEM, `balances(1)` wstDIEM via `convertToAssets`) for provenance and
`curveImbalanceRatio`. Guards: **both legs zero → fail-closed** (empty pool); define
`curveImbalanceRatio = 1` (force a warning) when both legs are 0 to avoid a `0/0 → NaN` that would
*suppress* the warning on the most-drained pool.

> *Interim only (discouraged):* if Part B must ship before rev-2, seed a conservative
> `2 × min(diemLeg, wstDiemLegInDiem)` and **label it interim** — it merely penalizes imbalance, still
> divides by ~2× the traded side for balanced pools (the SPEC002 §8 understatement stands), and is
> direction-blind (over-blocks a fat-DIEM-leg exit). Not the intended design.

### 4.3 `vaultApyBps` ← 7-day DB window

`vaultApyBps = Math.round(computeBaseApy(rollingCreditDiem_7d, averageVaultAssets_7d) × 10_000)` —
`computeBaseApy` returns a **fraction** (`src/metrics/math.ts:41`), so the `× 10_000` is mandatory to
reach bps; omitting it seeds a value 10,000× too small (every scenario blocks). Sourced from the SQLite
window (`listVaultAssetSamplesForWindow` + `listCreditSamplesSince` + the `status.ts` current-sample
append) aggregated by `applyYieldWindowMetrics` — a thin `loadVaultApyWindow` adapter, not a direct
reader.

- **Insufficient history → do NOT hard-error, and do NOT seed 0.** `applyYieldWindowMetrics` returns
  *"insufficient 7-day vault asset history for base APY evidence"* with no computed APY when the DB is
  short. In that case leave `vaultApyBps` to its normal SPEC002 path (explicit `--vault-apy-bps`, or
  the default/grid), set `vaultApySource: "not-seeded"` + `authoritative: false`, and **continue**
  sizing the other seeds. This keeps `--from-chain` usable on a fresh checkout (its first-run moment)
  and never silently seeds a leverage-amplified garbage APY.
- **No `--allow-stale-vault-apy`** — it is redundant with the existing `--vault-apy-bps` (the safe
  explicit override) and the cited reader cannot produce a short-window value anyway.
- **Sample-density floor.** Require ≥ N samples across the window (not merely a 7-day span) before
  stamping `vaultApySource: "measured-7d"` / authoritative (Open Question 2).

## 5. CLI surface

`loop sizing --from-chain [--planning-block <n>]`.

- **Precedence: explicit flag > chain seed > default.** A flag on a seeded dim wins and still sweeps
  (`--from-chain --morpho-supply-diem 100,1000` → grid on that dim, `seededFields.morphoSupplyDiem =
  "flag"`); seeded values are otherwise single points while non-seeded dims sweep as usual.
- **`--from-chain` + `--preset current-zero` → error** (the preset forces depth/supply to 0 while
  `--from-chain` seeds them — a direct zero-vs-value conflict). The static conflict guards
  (this and the flat-model error, §3.3) are checked **before** the RPC client is built, so a
  misconfigured invocation reports the real conflict rather than an RPC error.
- **`--preset liquidity-sweep` is allowed** — a chain-seeded dim (Morpho supply) collapses that
  preset's sweep on that dim to the live point, while the un-seeded dims (curve depth) still sweep.
  Provenance records the collapsed dim as `"chain"`. (This is the useful "sweep curve depth against
  today's real Morpho supply" case, not a conflict.)

## 6. Verdict integrity & provenance (extends SPEC002 §7)

**The central product-safety rule: any degraded seed demotes the verdict.** When `authoritative:
false` is tripped by *any* of — `rateAtTargetSource ≠ "direct"`; (Part B) `vaultApySource ≠
"measured-7d"`, or `curveImbalanceRatio > threshold`, or `get_dy` unavailable — the **status token
itself degrades on the verdict line** (e.g. `candidate — unverified seed`, not a plain `viable`), plus
a top banner. A warning read at the same glance as the verdict recalibrates trust; a `warnings[]` entry
does not.

```ts
interface SeedProvenance {
  blockNumber: bigint;                 // the pinned block for the on-chain reads (NOT vaultApy)
  chainId: number;
  rateAtTargetSource: "direct" | "uninitialized-default";   // inversion deferred out of Part A (§3.1)
  vaultApySource: "measured-7d" | "not-seeded";           // Part B
  curveDiemLegDiem?: bigint; curveWstDiemLegDiem?: bigint; // Part B
  curveImbalanceRatio?: number;                            // Part B
  seededFields: Record<string, "chain" | "flag" | "default">;  // incl. borrowApyBps note under flat
  authoritative: boolean;
  warnings: string[];
}
```

JSON nests `seedProvenance` (bigint legs as wei strings, SPEC002 §7.3) and a top-level
`authoritative`. Table prints `seeded from block N (chainId 8453)`, per-field source, the
(possibly degraded) verdict, and warnings. **JSON integrator note:** the per-scenario
`results[].status` carries the *true gate* result (`viable`/`marginal`/`blocked`) — the degradation
lives only in the human table token; a JSON consumer must **AND-combine** `results[].status` with the
top-level `authoritative` (a `viable` under `authoritative:false` is a candidate, not a pass).

## 7. What it explicitly does NOT do

Change the model beyond the §4.1 rev-2 prerequisite; sweep seeded dims; enable execution (broadcast
fail-closed, SPEC001); or make a `viable` safe on a thin pool without the fork `get_dy` proof.

## 8. Acceptance criteria (tests to write)

**Part A:**
1. `perSecWadToAprBps(686605546) === 217` (durable); the live-block value is a time-sensitive smoke test.
2. `rateAtTarget == 0` → fail-closed / `uninitialized-default` + `authoritative:false` — **not** clamp-to-10.
3. Non-zero rate clamps to `[10, 20000]`; a direct-read **revert fails closed** (inversion deferred, §3.1).
4. Fail-closed matrix: RPC down / `chainId≠8453` / `marketId` null / market revert / zero-or-codeless
   IRM/Morpho address / `totalSupplyAssets==0` → error, **no report**. (The "pinned block > threshold
   behind head" stale-pin arm is **deferred pending Open Question 1**'s threshold; `latest` mode pins
   to head so it cannot be stale, and `--planning-block` staleness is operator-intentional.)
5. `--from-chain --borrow-rate-model flat` → error (or seeds `borrowApyBps` + records it in provenance).
6. Precedence: an explicit `--morpho-supply-diem` overrides the seed (`seededFields.morphoSupplyDiem === "flag"`).
7. Block-pinning: the on-chain reads share one `blockNumber`; vaultApy exempt.
8. **A degraded seed demotes the verdict token** (not just a warning) and sets `authoritative:false` — the central product-safety test.
9. SPEC002 §7 conformance with seeded inputs (all gates evaluated, all economic fields populated, envelope shape unchanged).

**Part B (when SPEC002 rev-2 lands):**
10. Vault-APY **magnitude**: a measured 5% window → `vaultApyBps === 500` (guards the 10,000× unit bug).
11. Insufficient / low-density history → `not-seeded` + `authoritative:false` + sizing continues (no 0 seed, no hard error).
12. `get_dy`-seeded slippage is direction-correct (a fat-DIEM-leg exit is **not** over-blocked); both-legs-zero → fail-closed.
13. `--from-chain --preset current-zero` → error.

## Open questions

1. Concrete staleness threshold (blocks vs seconds) and the exact pinned tag (`latest` vs `safe`) — resolve before build.
2. Sample-density floor N for stamping vault APY authoritative.
3. SPEC002 rev-2 as its own roadmap item (it is the hard prerequisite for Part B) — Phase 3.5.
4. Should the imbalance / staleness thresholds be config-tunable or fixed heuristics (as SPEC002 §6's marginal band)?
