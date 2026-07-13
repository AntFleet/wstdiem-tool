# SPEC009 — Attributable inference-demand tracker (SPEC008 refinement)

**Status: REVIEWED + LOCKED (2026-07-13).** Two-agent pre-code gate (technical critic REVISE + product analyst
ACCEPT-WITH-RESERVATIONS) → fixes folded → confirmation pass (M2/M3/M4/M5 verified CLOSED line-by-line; 3 more
surgical Majors: `S_start` had no data path, two-residual mismatch, undefined tolerance) → fixed → LOCKED. Ready for
implementation.

> The shipped SPEC008 (`loop demand`) measures **NAV-ratchet velocity** — a lagging aggregate that CANNOT separate
> inference revenue from base DIEM-staking. This unit reads the **direct, attributable, on-chain events** by which
> inference USDC becomes wstDIEM yield, so the operator can **quantify the inference share with receipts** and track
> it growing as the protocol scales — honest attribution, not amplification. Read-only, decision-support (SPEC001 A3).

## 1. Problem & scope

`loop demand` tracks `d(NAV)/dt`. NAV rises from ALL yield — inference-fee routing AND the base DIEM
native-staking rate — so it cannot attribute revenue to inference or a venue. The protocol's thesis is that yield is
inference-demand-driven; the tool's job is to **quantify that share attributably and report it honestly** — including
that early-stage yield is partly protocol-seeded (expected while bootstrapping), with the organic inference share
growing as adoption scales.

Verified mechanism (source: `Liquid-Protocol-Ops/liquid-protocol-v0` `src/vault/`): inference USDC →
`{Surplus,X402}Adapter` settlement → operator `routeYield(minDiemOut)` swaps USDC→WETH→DIEM →
`InferenceVault.creditDIEM(holderDiem)` **stakes** the DIEM (`IDIEM.stake`) and raises the wstDIEM rate for all
holders (`DIEMCredited`), while the operator's share is compounded via `creditWstDIEM` (`WstDIEMCredited`).

**Scope.** Add an **attributable inference-demand readout** (`loop demand --flows`): ingest `DIEMCredited` /
`WstDIEMCredited` (vault) and `SettlementReceived` / `YieldRouted` (adapters) into SQLite via the existing backfill
path (accrued by the sampling cron), and report per-adapter USDC settled + DIEM credited, an **inference-vs-base
yield split** (the honesty headline), and honest velocity — all read-only, decision-support.

**Out of scope.** No change to the shipped NAV-velocity block (kept as the aggregate). No basis/market-price work
(parked until the Curve pool has liquidity — so **no** "slippage-vs-reference" here; there is no on-chain DIEM/USDC
reference price to compare against — report realized conversion only).

## 2. Events & exact semantics (verified against source)

Vault = `InferenceVault 0xe49FA849cB37b0e7A42B2335e333fb99474167ba`; adapters extend `BaseInferenceAdapter`.

| Event | Emitter | Fields (decimals) | Meaning |
|---|---|---|---|
| `SettlementReceived(uint256 amount)` | venue adapter | `amount` = **USDC, 6-dec** | inference USDC accumulated in the adapter. **USDC-transfer-backed** (both settlement fns `safeTransferFrom` before emitting) — the amount cannot be faked. **But see §3 trust tiers: on `X402Adapter` the entry is PERMISSIONLESS.** |
| `YieldRouted(uint256 usdc, uint256 diem, uint256 operatorShares)` | venue adapter | `usdc` **6-dec**, `diem` **18-dec** (gross swap out), `operatorShares` = wstDIEM 18-dec minted to operator | the USDC→WETH→DIEM conversion. `diem = holderDiem + operatorDiem` (split below). |
| `DIEMCredited(address indexed adapter, uint256 amount)` | vault | `amount` = **DIEM 18-dec** (gross, staked in full) | holder-benefiting inference yield, **attributable by `adapter`**. |
| `WstDIEMCredited(address indexed source, address indexed recipient, uint256 diem, uint256 shares)` | vault | 18-dec | the operator's compounded share (`creditWstDIEM`) — mints wstDIEM, does **not** raise the rate. |

**Fee decomposition (read BOTH live — owner-updatable):**
- `operatorFeeBps` (adapter, default **1000**/10%, cap **2000**/20%): `operatorDiem = YieldRouted.diem × operatorFeeBps/1e4`; `holderDiem = YieldRouted.diem − operatorDiem` → `DIEMCredited.amount = holderDiem`. So **`Σ DIEMCredited ≠ Σ YieldRouted.diem`**; `YieldRouted.diem = DIEMCredited.amount + WstDIEMCredited.diem` per `routeYield`.
- `yieldFeeBps` (vault, default **500**/5%, cap **2000**/20%, applied only if `treasury != 0`): taken as a **treasury SHARE MINT** (`_mint(treasury, feeShares)`), **NOT** a DIEM haircut. `DIEMCredited.amount` and the staked DIEM are the **full** amount; the fee dilutes NAV-per-share by ~`yieldFeeBps`.

**⚠ Decimals trap (load-bearing):** `usdc` fields are **6-dec**; all DIEM/wstDIEM fields **18-dec**. Every derived
ratio (DIEM-per-USDC conversion, any USDC↔DIEM compare) MUST scale USDC by `1e12`, or the number is off by 10^12.
Verify USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) is 6-dec. Pin a worked-example test (§7).

## 3. Trust semantics — three tiers (lead with what the chain PROVES)

Every published figure must be anchored to the strongest tier it belongs to. The readout labels these distinctly;
a test asserts self-reported figures are never emitted under an "inference volume"/"demand" key (§7).

- **Tier 1 — chain-proven, backing-verified (the primary number):** `DIEMCredited.amount` — DIEM actually staked,
  rate actually rose, backing is `DIEM.stakedInfos(vault)` (SPEC-verified). Publish claims off THIS.
- **Tier 2 — on-chain-real quantity, but caller not always the venue:** `SettlementReceived.amount` is
  USDC-transfer-backed (can't fake the amount). **However `X402Adapter.recordX402Settlement` is `external` with NO
  access control** — *any* address may push USDC and emit `SettlementReceived`. So "USDC settled on X402" ≠ "the
  authorized venue settled" — it may include USDC any payer (or a round-tripper) pushed. `SurplusAdapter` uses only
  the `onlyAuthorized receiveSettlement`. Label the caller/path is unidentifiable from the event.
- **Tier 3 — NEVER on-chain-verifiable (stated limitation, not an open question):** whether settled USDC reflects
  **third-party inference demand** vs. **protocol self-seeding** — the latter being **normal and expected while a
  young protocol bootstraps liquidity and demand**, not a red flag. No on-chain signal distinguishes the two, so the
  readout states plainly that the inference share it reports does not certify the demand is external; the honest
  expectation is that the organic share grows as adoption scales. (This is why OQ-D, a "SettlementReceived vs
  USDC-inflow" check, is **dropped**: both settlement paths `safeTransferFrom` real USDC, so an inflow *always*
  matches — the check adds nothing.)

**Guardrail:** lead every published claim with the Tier-1 `DIEMCredited` number + the inference-share headline
(§4); treat `SettlementReceived` and unrouted-USDC as explicitly self-reported, lower-tier context; **never** headline
self-reported USDC as "inference demand."

## 4. Metrics & the inference-vs-base headline

**Per adapter + aggregate, per window:**
- **DIEM credited** = Σ `DIEMCredited.amount` (18-dec), grouped by `adapter` (Tier 1). The attributable holder yield.
- **USDC settled** = Σ `SettlementReceived.amount` (6-dec), per adapter (Tier 2; X402 caveat).
- **Realized conversion** = from `YieldRouted`: DIEM-per-USDC (decimals-normalized) — realized only, no reference
  slippage (out of scope).

**Headline — inference-attributable share of realized yield (the honesty payoff):**
- **Total realized holder yield (window)** ≈ `ΔNAV × S_start`, where NAV = start/end `convertToAssets(1e18)` from the
  snapshots and `S_start` = **start-of-window** `totalSupply` (NOT end-of-window, which already includes the fee +
  operator + deposit share mints → double-counts dilution — the M1 trap). **`totalSupply` must be PERSISTED per
  snapshot** — today `collector.ts` reads it live only to compute NAV and discards it; the tool cannot reconstruct
  `S_start` from history without it (deriving it as `totalAssets × WAD / nav` re-introduces rounding on an already-
  thin band, so persist the real value). See §6 for the storage integration point.
- **Inference-attributable (window)** = `Σ DIEMCredited.amount`, reduced by the `yieldFeeBps` share-dilution
  (first-order factor `(1 − yieldFeeBps/1e4)`; read `yieldFeeBps` live; factor 1.0 when `treasury == 0`).
- **`inferenceSharePct`** = inference-attributable / total realized yield, reported **with an explicit
  tolerance/uncertainty band** (at ~81 DIEM TVL the residual is dominated by rounding + intra-window share-flow
  timing) — never a false-precision single %. **Residual** = base DIEM-staking accrual + deposit-fee revenue + noise;
  surface it. **The feature MUST report a low inference share honestly when that is what the chain shows** (early on,
  base-staking and seeded yield will dominate — that is expected) — reporting the unflattering number when it's true
  is exactly what makes the favorable number credible as adoption grows.
- **Secondary asset-side cross-check:** `Δ(DIEM.stakedInfos(vault).amountStaked)` should ≈ net stake inflows
  (deposits' staked DIEM + Σ `DIEMCredited` − **`flush()`/batch unstake amounts** — note "withdrawals" here means the
  `flush`/batch `initiateUnstake` that actually moves `amountStaked`, NOT `requestRedeem` share-burns, which touch
  only `pendingWithdrawalDiem`); the unexplained remainder is base DIEM-staking accrual. **This residual is NOT the
  same number as the NAV-side residual above** and the two must not be alarmed against each other: the NAV-per-share
  residual carries **deposit-fee share dilution** (a per-share-only confound — a deposit stakes its full gross DIEM
  regardless of the fee, so the fee never appears on the asset-side ledger), so the two diverge structurally even
  when everything is correct. Use the asset-side as an **independent integrity lens** on base-vs-inference, not a
  cross-check that must match the NAV-side to a tolerance; flag only asset-side divergence from *its own* expected
  net-inflow identity.

**Velocity/trend — gated:** WoW/DoD deltas of USDC-settled and DIEM-credited, but **only above a minimum flow-event
count** (mirror `MIN_DEMAND_WINDOW_SAMPLES = 2`, `demand.ts:8`). `routeYield` is lumpy/operator-triggered — 1→4
events is NOT "+300% velocity." Below the gate: show the **raw settlements**, render trend `n/a`. Never paint a
handful of lumpy events as a trend.

**Unrouted USDC balance (relabeled — was "pending demand"):** each adapter's **point-in-time** `USDC.balanceOf`
(not a windowed metric) — USDC received (`SettlementReceived`) but not yet `routeYield`'d. Purpose: a routing lull
with a rising balance is NOT a demand collapse (false-negative guard). Label it exactly **"unrouted USDC balance
(operator has not called `routeYield`)"** — a **state fact, not a forward signal**, and drop the word "demand." Note
`balanceOf` is a proxy that may include stray direct transfers or be reduced by `sweep()` (onlyOwner) with no
`YieldRouted`. It does **not** raise holder yield until routed; caveat as loudly as (or louder than) the routed number.

## 5. Fail-closed & honesty

- **Insufficient/missing data → `n/a`, never fabricated or zero-seeded.** No events + no unrouted USDC + below the
  min-events gate → `n/a`, explicitly.
- **Operator-triggered cadence:** zero `DIEMCredited` in a window ≠ zero demand — always pair with the unrouted-USDC
  balance (§4).
- **Tier-3 un-verifiability is a stated limitation** (§3) — on-chain data cannot distinguish third-party demand from
  protocol self-seeding (a normal bootstrapping stage); the readout says so and frames the inference share as
  growing with adoption, not as a verdict.
- **Not a yield promise / not advice** — past routing does not predict future yield; A3 framing throughout. The
  three A3 leak points to keep tight: velocity/trend (gated), unrouted-USDC (relabeled), and the `inferenceSharePct`
  headline (banded, must-publish-low).
- **Forward-only window bound:** the series begins at the shared cursor's position on the first inference-enabled
  tick (§6) — events before that are **absent by design**; the readout states the window's first-seen block. Full
  historical backfill needs an **archive RPC / Etherscan-v2 key**; the 6h cron accrues forward fine.

## 6. Integration points (rewritten per the technical review)

- **ABIs:** add vault events (`DIEMCredited`, `WstDIEMCredited`) + adapter events (`SettlementReceived`,
  `YieldRouted`) + reads `inferenceName()`, `isVenueAdapter(addr)`, `USDC.balanceOf(adapter)`, live `yieldFeeBps` /
  `operatorFeeBps`. Reuse `stringifyJson` (bigints → strings).
- **Decouple from the feeRouter guard (M3):** `backfill.ts:152` currently early-returns when `feeRouter == null`.
  SPEC009 events need only `inferenceVault` + the adapter set — **restructure so a null `feeRouter` skips ONLY the
  harvest scan**, and inference events accrue whenever `inferenceVault`+adapters are configured. (Otherwise the
  feature silently never accrues under a plausible config.)
- **Reuse the existing `lastProcessedBlock` cursor (M4):** do **not** introduce a second cursor — a fresh cursor
  triggers the `INITIAL_BACKFILL_LOOKBACK_BLOCKS` (302,400) single `getLogs`, which public RPCs reject. Sharing the
  cursor makes the first inference tick start near the tip = the honest forward-only bound (§5). Keep the 20-block
  reorg overlap.
- **Per-address getLogs (M5):** existing scans cover only `diem` + `feeRouter`. Add a `getLogs` on
  `inferenceVault` (`DIEMCredited`/`WstDIEMCredited`) and **one per configured adapter** (`SettlementReceived`/
  `YieldRouted`), filtered by address. Note the N-adapter per-tick `getLogs` cost. **The config-seeded adapter set
  is MANDATORY** (not discovery-only): an adapter that has emitted `SettlementReceived` but never `DIEMCredited` is
  invisible to `DIEMCredited`-based discovery, so the unrouted-USDC honesty feature can't see it without the config
  list. Resolve names live via `inferenceName()`; validate via `isVenueAdapter`.
- **Config schema:** extend `ContractsConfig` with `usdc` (address) and a venue-adapter set (array of `{address,
  name?}`; name resolved live via `inferenceName()` if omitted). Add loader/zod validation; do NOT add them to
  `missingDeploymentKeys` required-set (SPEC009 is additive/optional — absence → `n/a`, not a hard error).
- **Persist `totalSupply` (required by §4's `S_start`):** add `total_supply_diem TEXT NOT NULL DEFAULT '0'` to
  `metric_snapshots` via the existing `ensureColumn` retrofit pattern (already used in `sqlite.ts` for
  `vault_total_assets_diem`), add `totalSupply: bigint` to `MetricSnapshot` (`types/domain.ts`), write it in
  `insertMetricSnapshot`, and populate it in `collector.ts` (the value is **already fetched** at the
  `totalSupply` read that feeds `computeNav` — currently discarded; just carry it through). Without this the
  reconciliation headline has no start-of-window supply and §7.3 is un-buildable.
- **Storage:** new tables `inference_credit` (DIEMCredited/WstDIEMCredited) and `inference_settlement`
  (SettlementReceived/YieldRouted), bigints as TEXT, **PK `(tx_hash, log_index)` + `INSERT OR REPLACE`** (matches the
  codebase convention `sqlite.ts:63/75/88/322` and gives correct reorg-row replacement — NOT `(adapter, blockNumber,
  logIndex)`; `adapter` is a column). Reorg note: `runWatchOnce` passes the chain **tip** as `finalizedBlock`
  (`status.ts:93`), so the overlap re-scan + `tx_hash`-keyed replace is what self-heals a shallow Base reorg.
  Indicative DDL:
  ```sql
  CREATE TABLE IF NOT EXISTS inference_credit (
    tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, ts INTEGER NOT NULL,
    kind TEXT NOT NULL,            -- 'DIEMCredited' | 'WstDIEMCredited'
    adapter TEXT NOT NULL,         -- indexed adapter (DIEMCredited) / source (WstDIEMCredited)
    amount_diem TEXT NOT NULL,     -- 18-dec, TEXT bigint
    shares TEXT,                   -- WstDIEMCredited only
    PRIMARY KEY (tx_hash, log_index));
  CREATE TABLE IF NOT EXISTS inference_settlement (
    tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, ts INTEGER NOT NULL,
    kind TEXT NOT NULL,            -- 'SettlementReceived' | 'YieldRouted'
    adapter TEXT NOT NULL,         -- emitter adapter address
    usdc_amount TEXT,              -- 6-dec (SettlementReceived; YieldRouted.usdc)
    diem_out TEXT, operator_shares TEXT,  -- YieldRouted only, 18-dec
    PRIMARY KEY (tx_hash, log_index));
  ```
- **Cron:** the sampling `watch --once` tick must trigger this backfill each run (confirm it invokes the backfill;
  it already does for the NAV/credit path — extend that, don't add a parallel invocation).
- **Read/report:** `loop demand --flows` renders the per-adapter table + inference-share headline + unrouted-USDC
  under the existing NAV-velocity block; `--json` gains a `flows` object. `loop demand` WITHOUT `--flows` stays
  byte-identical (additive).

## 7. Acceptance criteria (tests when built)

1. **Decode + decimals:** `DIEMCredited(adapter, amount)` → adapter + 18-dec amount; `SettlementReceived` → 6-dec
   USDC; `YieldRouted(usdc, diem, operatorShares)` → correct units. **The decimals test:** `usdc=1_000_000` (1 USDC)
   + `diem=1e18` (1 DIEM) → conversion ≈ 1 DIEM/USDC, not 1e±12.
2. **Fee decomposition:** given `YieldRouted.diem` + live `operatorFeeBps`, `DIEMCredited.amount` == `diem ×
   (1−operatorFeeBps/1e4)` and `= diem − WstDIEMCredited.diem`; `Σ DIEMCredited ≠ Σ YieldRouted.diem` asserted.
3. **Inference-share headline + tolerance:** a worked synthetic window → `inferenceSharePct` computed with
   `S_start` (not end supply) and the `(1−yieldFeeBps/1e4)` dilution factor; the identity holds exactly on the
   no-rounding synthetic case; the tolerance/divergence threshold is a **concrete defined number** (config default),
   tested at the boundary. **A test where most yield is base-staking → the headline reports a LOW inference share**
   (honest reporting of the unflattering case works).
4. **Trust-tier labeling:** `SettlementReceived`-derived numbers carry the "as-reported / X402-permissionless" label
   and are never emitted under an "inference volume"/"demand" JSON key; `DIEMCredited` is the Tier-1 number.
5. **X402 permissionless:** a `SettlementReceived` from a non-`authorizedSettler` caller on X402 is still ingested
   but flagged unrestricted-path; not counted as authorized-venue demand.
6. **Min-events gate:** below `MIN_DEMAND_WINDOW_SAMPLES` flow-events → velocity/trend `n/a`, raw settlements still
   shown; at the threshold → computed (boundary test).
7. **feeRouter-null still accrues (M3):** with `feeRouter == null` but `inferenceVault` + adapters configured,
   inference events DO accrue (regression against the early-return).
8. **Cursor/forward-only (M4):** first inference-enabled tick starts near tip (no 302k lookback); the window's
   first-seen block is reported; pre-window events are absent — asserted, not implicit.
9. **Idempotency + reorg:** re-scan over an overlapping range does not double-count; PK `(tx_hash, log_index)` +
   `INSERT OR REPLACE` replaces a reorged row.
10. **Unrouted-USDC:** an adapter with `SettlementReceived` but no `YieldRouted`, holding USDC → non-zero
    point-in-time balance, labeled state-fact (no "demand"), and the window does NOT report zero.
11. **`--json` parity + serialization:** `data.flows` (per-adapter `usdcSettled`/`diemCredited`/`unroutedUsdc` +
    `inferenceSharePct` + residual) all as **strings**; `loop demand` without `--flows` byte-unchanged.

## 8. Open questions

- **[OQ-A]** Command surface: `loop demand --flows` (chosen) vs a separate command. `--flows` keeps the proxy +
  attributable + reconciliation co-located (honesty). Kept.
- **[OQ-B]** Backfill posture: forward-only from the shared cursor (chosen v1; honest window bound) vs archive-RPC
  full history (operator upgrade).
- **[OQ-C]** `creditWstDIEM` (operator compounding) is NAV-neutral (mints shares, no rate raise) — excluded from the
  inference-share numerator and the NAV cross-check; tracked only as "operator take." Confirm the operator-take
  readout is DIEM-denominated (value `operatorShares` at rate) or clearly marked as raw shares.
- **[OQ-E — RESOLVED v1]** `inferenceSharePct` tolerance/divergence default = **500 bps** (i.e. the residual band is
  ±5% of realized-yield; `inferenceSharePct` clamped to `[0,100]` and shown as a band, not a point), config-tunable
  via `thresholds.inferenceReconcileToleranceBps`, **revisit after the first live window with real data** (at ~81
  DIEM TVL rounding dominates, so this is a starting value, not a calibrated one). §7.3's "concrete defined number"
  = this default. The band only guards the NAV-side headline; the asset-side lens is judged against its own
  net-inflow identity (§4), not cross-matched.
- ~~OQ-D~~ (dropped — see §3: both settlement paths transfer real USDC, so an inflow always matches; the check
  proves nothing about demand authenticity).

## 9. Traceability

Each §7 criterion → a test (`test/inference-flows.test.ts` for decode/decimals/fee-decomp/share/labeling;
compiled-CLI for `loop demand --flows` + `--json`). Source of truth: `Liquid-Protocol-Ops/liquid-protocol-v0`
`src/vault/InferenceVault.sol` + `src/vault/adapters/{BaseInference,Surplus,X402}Adapter.sol`. Roadmap Phase 10.
**No code until this spec passes a confirmation pass and is LOCKED.**
