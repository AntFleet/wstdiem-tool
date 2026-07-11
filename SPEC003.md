# SPEC003 — Loop sizing: live on-chain seeding (`loop sizing --from-chain`)

> **Forward spec** — authored **before** implementation (Phase 3 of the roadmap: spec-first for new
> work). It defines the contract an implementer builds to; acceptance criteria (§10) become the tests.
> **Conforms to [`SPEC002.md`](SPEC002.md)** — it seeds SPEC002's scenario inputs; it does not change
> the sizing model, gates, or output contract.

## 1. Purpose & scope

`loop sizing --from-chain` turns the offline sizing engine from typed assumptions into "what today's
actual Base pool supports" by seeding five scenario inputs from live reads, **reusing readers that
already exist**:

| Seeds | from |
|---|---|
| `rateAtTargetApyBps` | AdaptiveCurveIrm `rateAtTarget(marketId)` (§3) |
| `morphoSupplyDiem` | Morpho `market(marketId).totalSupplyAssets` |
| `morphoExistingBorrowDiem` | Morpho `market(marketId).totalBorrowAssets` |
| `curveDepthDiem` | Curve `balances(0)` + `convertToAssets(balances(1))` (§4) |
| `vaultApyBps` | empirical 7-day base APY from the metrics DB (§5) |

**It upgrades *inputs*, not the *model*.** Every SPEC002 §8 limitation still stands (single-scalar
depth cannot fully model convex off-peg slippage; gas/MEV excluded; HF is not liquidation distance;
no price path). `--from-chain` must not be presented as "now the numbers are real" — it removes
garbage-in on five inputs and adds provenance, nothing more. Broadcast stays disabled (SPEC001).

## 2. The seeding map

Each seed reuses an existing reader and is **block-pinned** to one planning block (§6):

| Scenario field | Live source | Reused reader (file) |
|---|---|---|
| `rateAtTargetApyBps` | `AdaptiveCurveIrm.rateAtTarget(marketId)` → `int256` per-second WAD → `perSecWadToAprBps` | new ABI fn on `src/abi/morphoIrm.ts`; `perSecWadToAprBps` in `src/loop/morphoRate.ts` |
| `morphoSupplyDiem` | `Morpho.market(marketId).totalSupplyAssets` | `readMorphoMarket` (`src/loop/preflight.ts:520`) |
| `morphoExistingBorrowDiem` | `Morpho.market(marketId).totalBorrowAssets` | same |
| `curveDepthDiem` | `Curve.balances(0)` + `InferenceVault.convertToAssets(balances(1))` | readiness curve reads (`src/loop/readiness.ts:299,306`) |
| `vaultApyBps` | `computeBaseApy(rollingCreditDiem_7d, averageVaultAssets_7d)` | `applyYieldWindowMetrics` (`src/metrics/collector.ts:81`) |

## 3. `rateAtTarget` — direct read, not inversion

**Primary (required): read `rateAtTarget(marketId)` directly** from the AdaptiveCurveIrm. It is a
public getter returning `int256` per-second WAD; convert to APR bps via `perSecWadToAprBps`. This is
robust and has no conditioning problem.

> Verified 2026-07-11, IRM `0x46415998764C29aB2a25CbeA6254146D50D22687`, market
> `0xdd6b9f10…6c76`: `rateAtTarget = 686605546` per-second WAD → **≈ 216.5 bps**. (This is the value
> the runbook recommends passing manually today.)

**This resolves the SPEC002 §10 caveat.** That section assumed seeding by *inverting*
`borrowRateView ÷ curveMultiplier(currentUtil)`, which is ill-conditioned near the current ~42%/idle
regime. The inversion is **unnecessary** given the direct getter — catching this is exactly the
payoff of speccing before building.

**Fallback (only if the direct read reverts / is unavailable):** invert
`borrowRateView ÷ curveMultiplierWad(currentUtil)`, and when `currentUtil` is in the shallow zone
(multiplier < ~0.5×, i.e. util well below the 90% target) mark the seed `rateAtTargetSource:
"inverted-ill-conditioned"` and surface a warning — do not silently trust it.

**Both paths** clamp the result to Morpho's `[MORPHO_MIN_RATE_AT_TARGET_APR_BPS = 10,
MORPHO_MAX_RATE_AT_TARGET_APR_BPS = 20000]` bounds (already exported by `morphoRate.ts`).

## 4. Curve depth — and the imbalance opportunity

Reading `balances(0)` (DIEM leg) and `balances(1)` (wstDIEM leg) **separately** gives `--from-chain`
the very data SPEC002 §8 named as the model's headline blind spot: pool imbalance. Two options for
collapsing them into SPEC002's single `curveDepthDiem` scalar:

- **(a) naive total** — `balances(0) + convertToAssets(balances(1))`. Inherits the imbalance blindness
  (a drained/off-peg pool reads as deep). **Rejected as default.**
- **(b) conservative (default):** `curveDepthDiem = 2 × min(diemLeg, wstDiemLegInDiem)` — treat the
  pool as if balanced at its **thinner** leg, so exit slippage is priced against the drained side an
  exit actually draws from. Additionally emit `curveImbalanceRatio =
  |diemLeg − wstDiemLegInDiem| / (diemLeg + wstDiemLegInDiem)` and a warning when it exceeds a
  threshold (default 0.20).

So `--from-chain` is a **partial fix** for SPEC002's headline limitation, not merely an input upgrade.
It does **not** fully solve it: the single-scalar model still cannot price convex off-peg slippage, so
a fork `get_dy` proof remains required before trusting a `viable` verdict on a thin pool (SPEC002 §8).

## 5. Vault APY needs history — fail-closed

`vaultApyBps` is **not** a single RPC read. It is the 7-day rolling base APY
(`computeBaseApy(rollingCreditDiem_7d, averageVaultAssets_7d)`) computed from `credit_events` +
`metric_snapshots` in the SQLite DB (populated by prior `watch --once` runs). If the DB lacks ≥7 days
of vault-asset history, `applyYieldWindowMetrics` returns *"insufficient 7-day vault asset history."*

**`--from-chain` must fail-closed on vault APY** — it must never silently seed a garbage or zero APY
(which leverage would then amplify, SPEC002 §8). Default behavior: if history is insufficient, **error**
and instruct the operator to either run `watch --once` over a ≥7-day span first or pass
`--vault-apy-bps` explicitly. An `--allow-stale-vault-apy` escape hatch may seed it anyway, but then
the scenario carries `vaultApySource: "insufficient-history"` and a prominent warning, and the run is
marked non-authoritative.

## 6. RPC discipline (chain in an otherwise-offline command)

`--from-chain` is the **only** chain-reading path in `loop sizing`; the base command stays pure-offline
(SPEC002 §1). It therefore carries its own discipline:

- **Block-pinning (TOCTOU):** read `latest` once (or `--planning-block <n>`), then pin **every** seed
  read to that single block — same discipline as preflight/readiness. A mixed-block seed set is a bug.
- **Fail-closed, no partial seeding:** if RPC is unavailable, `chainId ≠ 8453`, `marketId` is null, any
  seed read reverts, or a read returns an implausible value (zero supply where nonzero is required),
  the command **errors** and emits no sizing report. The only exception is `vaultApyBps` under §5.
- **Reuse the existing failover/quorum client** (`src/contracts/rpc.ts`); reject a pinned block older
  than a staleness threshold (default: > ~50 blocks / ~100s behind head).
- The seed reads are read-only `eth_call`s; nothing is signed or broadcast.

## 7. CLI surface

`loop sizing --from-chain [--planning-block <n>] [--allow-stale-vault-apy]`.

- **Precedence: explicit flag > chain seed > default.** An operator may pin any seeded dimension with
  its normal flag (e.g. `--morpho-supply-diem`), and `--from-chain` fills only the rest. The seeded
  values are **single points**, not swept; leverage and other non-seeded dims sweep as usual (SPEC002
  §2.2), so `loop sizing --from-chain --target-leverage 2,3,4` sizes today's real pool across leverage.
- `--planning-block <n>` pins a specific block (default: latest at invocation).
- All other SPEC002 flags behave unchanged.

## 8. Output & provenance (extends SPEC002 §7)

`--from-chain` adds a `seedProvenance` object to the report; the `LoopSizingResult`/`LoopSizingReport`
contract is otherwise unchanged (seeded values simply populate the scenario inputs):

```ts
interface SeedProvenance {
  blockNumber: bigint;             // the single pinned block
  chainId: number;
  rateAtTargetSource: "direct" | "inverted" | "inverted-ill-conditioned";
  vaultApySource: "measured-7d" | "insufficient-history";
  curveDiemLegDiem: bigint;        // balances(0)
  curveWstDiemLegDiem: bigint;     // convertToAssets(balances(1))
  curveImbalanceRatio: number;     // §4
  seededFields: Record<"rateAtTargetApyBps"|"morphoSupplyDiem"|"morphoExistingBorrowDiem"|"curveDepthDiem"|"vaultApyBps",
                       "chain" | "flag" | "default">;
  warnings: string[];
}
```

- **JSON** (`--json`) nests `seedProvenance` alongside `assumptions`/`results`. bigint legs serialize as
  wei strings (SPEC002 §7.3 rules).
- **Table** prints a header line — `seeded from block N (chainId 8453)` — and a per-field source
  annotation, plus any warnings (imbalance, ill-conditioned rate, stale vault APY).

## 9. What it explicitly does NOT do

- Does not change the model — every SPEC002 §8 limit stands (single-scalar depth, gas/MEV excluded,
  HF ≠ liquidation distance, no price path).
- Does not sweep the seeded dimensions (each is one live point).
- Does not enable execution — broadcast remains fail-closed (SPEC001 §5/§9).
- Does not, by itself, make a `viable` verdict safe on a thin/off-peg pool (fork `get_dy` proof still
  required).

## 10. Acceptance criteria (tests to write when built)

1. **Direct rate read** reproduces ≈ 216–217 bps at a pinned 2026-07-11 Base block (fork test), and
   `perSecWadToAprBps(686605546) ≈ 2165` (…/10 bps precision).
2. **Fallback inversion** matches the direct read within tolerance in a well-conditioned (near-target
   util) fixture, and is flagged `inverted-ill-conditioned` in a low-util fixture.
3. **Rate clamp** to `[10, 20000]` bps on both paths.
4. **Fail-closed:** RPC down / `chainId ≠ 8453` / market revert / stale pinned block → command errors,
   **no partial report emitted**.
5. **Vault APY §5:** insufficient history → error by default; under `--allow-stale-vault-apy` →
   `vaultApySource: "insufficient-history"` + warning + non-authoritative marking.
6. **Precedence:** an explicit `--morpho-supply-diem` overrides the chain seed for that dim
   (`seededFields.morphoSupplyDiem === "flag"`).
7. **Imbalance:** a lopsided-pool fixture yields `curveDepthDiem = 2 × min-leg` and a
   `curveImbalanceRatio > 0.20` warning; a balanced fixture yields ≈ the naive total with no warning.
8. **Block-pinning:** all seed reads use the identical block (assert one `blockNumber` across reads).
9. **Contract conformance:** a seeded report still satisfies SPEC002 §7 (all gates evaluated, all
   economic fields populated, JSON envelope shape unchanged) — reuse SPEC002's acceptance fixtures with
   seeded inputs.

## Open questions

1. Conservative curve-depth seeding (§4b) as the default vs opt-in — **recommend default conservative**
   (the tool's whole premise is safety on a drained pool).
2. Vault-APY insufficient-history — hard error vs annotated-warn default — **recommend hard error**.
3. Exact staleness threshold for the pinned block (blocks vs seconds).
4. Should `--from-chain` also seed the flat-model `borrowApyBps` for flat-model users, or only the
   adaptive `rateAtTargetApyBps`? — adaptive is the default model; flat users can still pass
   `--borrow-apy-bps`.
5. Should the imbalance threshold (0.20) and staleness threshold be configurable (`config` / flags) or
   fixed heuristics like SPEC002 §6's marginal band?
