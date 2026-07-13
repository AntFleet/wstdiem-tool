# SPEC006 — Capacity + live brief

**Status: REVIEWED + LOCKED (2026-07-13).** Two-agent pre-code gate (technical critic + product
analyst, both **REVISE**) → fixes folded → focused confirmation pass (**ACCEPT-WITH-RESERVATIONS**)
→ residual Majors M1–M4 folded → LOCKED. Ready for implementation.

> **Forward spec** (authored before implementation; acceptance criteria = the tests to write).
> **Conforms to [`SPEC002.md`](SPEC002.md) + [`SPEC003.md`](SPEC003.md).** Reuses the sizing gates and
> `--from-chain` seed path; does **not** invent new gate math. Decision-support only (SPEC001 A3 /
> OQ#6): capacity is a **point-in-time, last-candidate gate-bound absorption bound** — not a promise
> that capital can be deployed, not investment advice, and not "safe full size."

## 1. Problem & scope

The founder is attracting large capital into the leveraged wstDIEM strategy. The number capital
needs is **how much equity (and therefore leveraged notional) clears this tool's sizing gates today
before status leaves `candidate`** — not a static table row and not "TVL × some multiple." Only this
tool's gates compute that bound: Curve exit depth/slippage (per-leg + live `get_dy`), Morpho
util-capped borrow headroom, health factor (structural in leverage), net APY, and unwind coverage.

Today the operator must hand-sweep `--initial-diem` grids and eyeball the flip. There is also no
scheduled artifact that packages the live net-APY grid + capacity + **deltas vs the previous
comparable run** for a recurring post/cron brief.

**Scope.** Two CLI surfaces, one shared search:

| Surface | Job |
|---|---|
| **`loop capacity`** | At a fixed target leverage `L`, find the largest equity `E` for which `sizeLoopScenario` returns `status === "candidate"` (last-candidate), report notional from the engine ceil, name the **binding** constraint on the first non-candidate above, and report headroom-to-hard-block. |
| **`loop brief`** | Emit a decision-support brief: capacity (default leverage grid) + net-APY snapshot + **Δ vs the last *comparable* stored brief run**. Persist this run so the next run has a baseline. |

**Impl note — default leverages vs HF proximity (folded post-executor).** Structural HF =
`LLTV·L/(L−1)` is equity-independent. Under default `minPostLoopHealthFactor` 1.7, the engine's
`isMarginal` health band is HF < 1.1×1.7 ≈ 1.87. At **2.0×**, HF ≈ 1.72 always trips that band →
last-candidate capacity is **0 / `marginal-band` for every market depth**. Defaults therefore use
**capacity `1.5`** (HF ≈ 2.58) and brief grid **`1.5,1.8`** (1.8× HF ≈ 1.935 clears the band). 2×
and 3× remain opt-in flags; the CLI emits a structural-HF proximity warning when capacity is
identically zero for that reason.

**Headline lexicon (normative — render + docs + JSON labels).** Use **"gate-bound absorption
(last-candidate)"** / **"gates clear up to …"**. Ban **"deployable capacity"**, **"can absorb and
deploy"**, **"deploy up to"** in CLI output and `docs/deployment/*`. HANDOFF internal copy is not
normative for the public surface.

**Out of scope.**
- No broadcast, no position open, no X post, no fund movement.
- No new sizing gates and no re-implementation of shortfall math — reuse `sizeLoopScenario` + E1 shortfalls.
- No change to SPEC004 exit-code ladder (capacity/brief are advisory like `loop sizing`: `0` success / `1` error).
- No demand velocity (SPEC008) or basis (SPEC007) in this unit — the brief's persistence table is the seam those units will extend later; this unit only stores capacity-relevant figures.
- No multi-actor / concurrent-flow model (stated as a caveat, not estimated).

## 2. Capacity — definition, units, search

### 2.1 Definition

For a fully-populated `LoopSizingScenario` template `T` (all fields fixed except equity) and a target
leverage `L` (bps `targetLeverageBps`):

```text
capacityEquityDiem(L, T) = max { E ∈ WAD-DIEM, E > 0 :
  sizeLoopScenario(T with initialCollateralDiem = E, targetLeverageBps = L).status === "candidate" }
```

If no such `E` exists → `capacityEquityDiem = 0n`, `capacityStatus` ∈ {`"marginal"`, `"blocked"`}
per §2.4 — **never** a third `"none"` status.

**Why `candidate`, not max non-blocked.** `candidate` means every hard gate clears **and** the
engine's proximity band does not trip (`isMarginal`: slip > 80% of cap, HF < 1.1× min, net APY <
min+200, or stressed-netAPY near-fail above the util band — SPEC002 rev-3). At `capacityEquityDiem`
the next increment is already `marginal` or `blocked`. Larger sizes may still be non-blocked
(`marginal`); that is **not** this unit's headline capacity. A `candidate` is "clears gates under
the model for deeper validation" (SPEC002) — **not** approval to act and **not** a comfortable
operating size (there is no operator buffer baked in).

**Secondary metric (always computed in JSON; secondary human line; clearly labeled riskier):**

```text
headroomToBlockEquityDiem = max { E : status(E) ≠ "blocked" }   // includes marginal
```

Rendered as **"headroom to hard block (includes marginal — riskier)"**. Never the headline number.
When equal to capacity, omit the distinction in the human one-liner but still emit both fields in
JSON (`headroomToBlockEquityDiem` may equal `capacityEquityDiem`).

**Leveraged notional (normative — no free product formula) for BOTH metrics:**

```text
capacityNotionalDiem =
  capacityEquityDiem === 0n
    ? 0n
    : positionCollateralForScenario(capacity scenario)   // mulDivCeil(E, L) in sizing.ts

headroomToBlockNotionalDiem =
  headroomToBlockEquityDiem === 0n
    ? 0n
    : positionCollateralForScenario(headroom scenario)
```

Do **not** compute `E * L / 10000` with truncating integer division in the capacity layer — always
call / mirror `positionCollateralForScenario` so notional matches the gate input.

**Units.** All token amounts are WAD (1e18) `bigint`. Leverage is bps (`20000` = 2.0×). Rates in bps.
JSON serializes every `bigint` as a **string** via the existing `stringifyJson` replacer.

### 2.2 What is fixed in the template `T`

Capacity freezes the market inputs and sweeps only equity:

| Input | Source (live / offline) | Notes |
|---|---|---|
| Curve legs / Morpho supply / existing borrow / rateAtTarget / vaultApy | `--from-chain` seed (SPEC003) or **explicit** market flags | Same precedence as `loop sizing --from-chain` |
| `targetLeverageBps` | `--target-leverage` (single value; **optional, default `1.5`** → 15000 bps) | Must be `> 1`; parse via the sizing leverage parser (`>1`, ≤4 dp → bps) — **not** the loop open/rebalance 1.5–3.8 clamp. Default is 1.5 (not 2) so structural HF clears the proximity band under min HF 1.7 — see §1 impl note. |
| fees, share caps, min HF, min net APY, holding days, gas | config / existing sizing flags | Unchanged from SPEC002 |
| `externalExitSlippageBps` | live `get_dy` **re-quoted per candidate size** when curve is chain-seeded | Injectable quoter; block-pinned (§2.3) |

**Input mode (required on every result):**

| `inputMode` | When |
|---|---|
| `"from-chain"` | `--from-chain` set and seed succeeded |
| `"explicit-flags"` | no `--from-chain`, but operator supplied enough market legs+supply (§2.7) |
| `"offline-defaults"` | only reachable via `--allow-offline-defaults` escape hatch (§2.7) |

**Live Morpho headroom (informational, not a second gate).** Report

```text
morphoRawAvailableDiem = max(0, totalSupplyAssets − totalBorrowAssets)
```

as a **readout only**. The engine's binding Morpho check remains util-capped
(`availableMorphoBorrowDiem = floor(supply × maxMorphoUtilizationBps/10000) − existingBorrow`) — do
**not** replace the engine gate with the raw number. Human table: three adjacent rows —
`Morpho raw unborrowed (info)` / `Util-capped borrow headroom (gate)` / `Capacity notional
(last-candidate)` — never title raw available as capacity.

### 2.3 Search algorithm (normative pseudocode)

**Monotonicity (operational, not a theorem).** With `gasCostDiem === 0` (engine default),
`isCandidate(E)` is **treated as** a downward-closed predicate for search: if `E` is non-candidate
then every `E' > E` is treated as non-candidate. Residual risk (integer `ceil` / `numberRatioBps`
1-bps wobble; marginal-band flips) is accepted; AC4 pins the operational claim on fixtures, not a
formal proof. With `gasCostDiem > 0`, net-APY can improve with size (fixed cost annualizes ∝ 1/E) —
the gas-path steps below are mandatory.

**Constants (v1, code constants — not config knobs):**

| Constant | Default | Role |
|---|---|---|
| `minProbeEquity` | `10^15` (0.001 DIEM) | Dust floor |
| `maxProbeEquity` | `10^24` (1_000_000 DIEM) | Hard search window cap |
| `ladderGrowth` | `2` | Geometric ladder step |
| `searchResolutionDiem` | `10^16` (0.01 DIEM) | Binary-search stop |
| `maxGetDyQuotes` | `64` | Memoized distinct position sizes per search |

**Probe set.** Geometric ladder `E_k = minProbeEquity * 2^k` for `k = 0,1,…` while `E_k < maxProbeEquity`,
**always including `maxProbeEquity` as a final probe**. Every probe evaluates
`sizeLoopScenario` (after optional get_dy inject for that size).

**Step A — ladder scan** (strict order — do not short-circuit island bisect):

1. Evaluate every ladder point including `maxProbeEquity`. Build ordered `(E, status, result)`.
2. **If no ladder point is `candidate`:** for each consecutive non-candidate pair `(E_i, E_{i+1})`
   whose **blocker families** differ, bisect `[E_i, E_{i+1}]` for any `candidate` (island recovery).
   Family classifier (pure, pinned):
   `family(result) = firstBlocker ?? (status === "marginal" ? "marginal-band" : "none")`.
   Trigger when `family(E_i) !== family(E_{i+1})` and neither side is candidate. If a candidate is
   found in any bisect, treat the search as "some candidate found" and continue to step 3 with the
   updated probe set. If still no candidate after all such bisects → §2.4 zero path (use
   **`minProbeEquity`** result for `bindingEdge` / `bindingConstraint`).
3. **Else if `status(maxProbeEquity) === "candidate"`** →
   `capacityEquityDiem = maxProbeEquity`, `bindingConstraint = "unbounded-in-search-window"`,
   `bindingEdge = null`. Skip binary refine past max. Human render:
   `≥ maxProbe (search window — not a market limit)`.
4. **Else** (some candidate, and a first non-candidate exists above the largest candidate) →
   set `low = largest candidate E`, `high = first non-candidate E` with `high > low`. Proceed to
   Step B.

**Step B — binary refine** (last-candidate):

```text
// Invariant: status(low) === "candidate"; status(high) !== "candidate" (or high is exclusive bound)
// mid uses bigint floor division
while high - low > searchResolutionDiem:
  mid = (low + high) / 2n
  if isCandidate(mid): low = mid
  else: high = mid
capacityEquityDiem = low
capacityEdge = result(low)
bindingEdge = result(high)   // first non-candidate at/above the refined boundary
bindingConstraint = taxonomy(bindingEdge)   // §2.5
```

**Headroom-to-block** uses the same ladder+binary machinery with predicate `status !== "blocked"`
(optional second refine; may share probes).

**`get_dy` re-quote (chain-seeded curve only).**

- Resolve **`blockNumber` once** from the seed (SPEC003); every `convertToShares` / `get_dy` in this
  search is pinned to that block (no TOCTOU across quotes).
- Injectable quoter signature (conceptual):
  `quoteExitSlippage(positionCollateralDiem, blockNumber) → { bps } | { demote: reason } | hard-fail`.
- Distinct `positionCollateralDiem` values get distinct quotes (memoize by
  `positionCollateralDiem` + `maxSlippageBps`). Never reuse one size's quote on another.
- **Hard fail** (RPC/revert after seed started) → abort the command, **no** `LoopCapacityResult`
  (same class as `FROM_CHAIN_SEED_BLOCKED`). Do not emit partial capacity.
- **Soft unavailable** (readiness-only / no quote) → `authoritative = false`, fall back to leg-aware
  estimate, continue (SPEC003 §6 parity).
- **Budget:** count memo misses only toward `maxGetDyQuotes`. If budget exhausts:
  - If a proven `(low, high)` candidate bound already exists → stop refining, set
    `search.truncated = true`, return best proven `low`.
  - If no candidate bound is established yet → **fail closed** (no capacity number), warning
    `GET_DY_BUDGET_EXHAUSTED_BEFORE_BOUND`.

Do **not** import a private `computeExitSlippageInjection`; export a shared helper or inject from
CLI wiring only.

### 2.4 Status when capacity is zero / unbounded

| Condition | `capacityEquityDiem` | `capacityStatus` | `bindingConstraint` | `capacityEdge` / `bindingEdge` |
|---|---|---|---|---|
| Last-candidate found, bound above exists | `E*` | `"candidate"` | from `bindingEdge` (§2.5) | last candidate / first non-candidate |
| Still candidate at `maxProbeEquity` | `maxProbeEquity` | `"candidate"` | `"unbounded-in-search-window"` | capacityEdge at max / `bindingEdge = null` |
| Never candidate; ≥1 probe `marginal` | `0` | `"marginal"` | `"marginal-band"` | `capacityEdge = null` / `bindingEdge = minProbe result` (or best marginal probe — pin **minProbe**) |
| Never candidate; all probes `blocked` (or HF invalid at every size) | `0` | `"blocked"` | from `bindingEdge = minProbe result` | null / minProbe |
| Seed/RPC/hard get_dy failure | *no report* | — | — | command errors — fail closed |
| Offline refuse (§2.7) | *no report* | — | — | tool-error with clear code |

There is **no** `capacityStatus: "none"`.

### 2.5 Binding-constraint taxonomy

Always derived from **`bindingEdge`** (or the §2.4 zero/unbounded rows). Prefer engine outputs —
**do not re-derive gate math**:

| Engine signal on `bindingEdge` | `bindingConstraint` |
|---|---|
| `firstBlocker === "morpho_supply_insufficient"` | `"morpho-util-headroom"` |
| `firstBlocker === "curve_liquidity_insufficient"` and `exitSlippageExcessBps > 0` | `"curve-exit-slippage"` |
| `firstBlocker === "curve_liquidity_insufficient"` otherwise | `"curve-depth"` |
| `firstBlocker === "net_apy_below_threshold"` | `"net-apy"` |
| `firstBlocker === "health_factor_below_threshold"` | `"health-factor"` |
| `firstBlocker === "unwind_not_covered"` | `"unwind"` |
| `firstBlocker === "scenario_invalid"` | `"scenario-invalid"` |
| status `marginal` (no blocker) | `"marginal-band"` |
| still `candidate` at `maxProbeEquity` | `"unbounded-in-search-window"` |

```ts
type BindingConstraint =
  | "morpho-util-headroom"
  | "curve-exit-slippage"
  | "curve-depth"
  | "net-apy"
  | "health-factor"
  | "unwind"
  | "scenario-invalid"
  | "marginal-band"
  | "unbounded-in-search-window";
```

**Render glosses (human table):**
- `morpho-util-headroom` — util-capped Morpho borrow headroom (not raw unborrowed).
- `health-factor` — structural at this leverage; reduce leverage, not equity.
- `marginal-band` — near hard gates; emit `marginalReasons: string[]` best-effort from the engine
  signals that made `isMarginal` true (slip near cap / HF near floor / APY near floor / stressed).
- `unbounded-in-search-window` — `≥ maxProbe`; not a market capacity claim.
- `net-apy` — often sensitive to vault-APY assumption; caveat when vault APY is not `measured-7d`.

Also emit E1 shortfalls from **`bindingEdge`** (when non-null):
`morphoSupplyShortfallDiem`, `curveDiemLegSlippageShortfallDiem`, `exitSlippageExcessBps`,
`netApyShortfallBps`, `availableMorphoBorrowDiem`.

### 2.6 Result shape (`LoopCapacityResult`)

```ts
interface LoopCapacityResult {
  targetLeverageBps: number;
  capacityEquityDiem: bigint;          // 0 when none
  capacityNotionalDiem: bigint;        // positionCollateralForScenario; 0 when none
  headroomToBlockEquityDiem: bigint;   // max E with status !== "blocked"; 0 when all blocked
  headroomToBlockNotionalDiem: bigint;
  capacityStatus: "candidate" | "marginal" | "blocked";
  bindingConstraint: BindingConstraint;
  capacityEdge: LoopSizingResult | null;  // last candidate scenario result
  bindingEdge: LoopSizingResult | null;   // first non-candidate / zero-establishing probe
  marginalReasons: string[];              // from bindingEdge or capacityEdge when marginal
  morphoRawAvailableDiem: bigint;         // informational
  availableMorphoBorrowDiem: bigint;      // util-capped (from bindingEdge or seed-level)
  search: {
    probes: number;                       // sizeLoopScenario calls
    getDyQuotes: number;                  // memo misses
    resolutionDiem: bigint;
    truncated: boolean;
    minProbeEquityDiem: bigint;
    maxProbeEquityDiem: bigint;
  };
  inputMode: "from-chain" | "explicit-flags" | "offline-defaults";
  seedProvenance?: SeedProvenance;
  authoritative: boolean;                 // required; false offline / degraded / soft get_dy
  warnings: string[];
  // Structured honesty (required — not only a free-text disclaimer)
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];  // stable codes, see below
  disclaimer: string;      // fixed human string
}
```

**`modelCaveats` stable codes (subset always present as applicable):**
`single-block-snapshot`, `no-concurrent-flow`, `last-candidate-no-operator-buffer`,
`gas-unmodeled-unless-flagged`, `vault-apy-input`, `linear-or-get_dy-slippage-model`,
`spec002-section-8`.

**`disclaimer` (exact, fixed):**

> `"Point-in-time gate-bound absorption (last-candidate) under this tool's sizing gates — not a promise that capital can be deployed, not investment advice, and not a comfortable full-size operating point (the next increment is already marginal or blocked). Assumes no concurrent Morpho/Curve draw by other actors. Pool depth, borrow caps, and rates can move; the operator/keeper must decide and act out-of-band."`

### 2.7 Refuse offline fantasy capacity (OQ-B resolved)

Capacity and brief **refuse** when neither:

1. `--from-chain` is set, **nor**
2. the operator supplied **explicit** market depth+supply sufficient to size:
   (`--curve-depth-diem` **or** both `--curve-diem-leg` + `--curve-wstdiem-leg`) **and**
   `--morpho-supply-diem`,

unless `--allow-offline-defaults` is set.

- Refuse → tool-error (`INVALID_INPUT` / dedicated `OFFLINE_CAPACITY_REFUSED`), **no** capacity
  number (not `0`), **no** `brief_runs` insert.
- `--allow-offline-defaults` → `inputMode: "offline-defaults"`, `authoritative: false`,
  non-suppressible banner `OFFLINE DEFAULTS — not live capacity`, and **do not persist** the run
  into the capital delta chain (`persistable: false` — see §3.2).

## 3. Live brief

### 3.1 Purpose

A single command a cron can run that prints:

1. **Capacity** at each requested leverage (default **`1.5,1.8`** — both clear the HF proximity band
   under `minPostLoopHealthFactor` 1.7; see §1 impl note). **2× / 3× are opt-in:** under default min
   HF, 2× is always `marginal-band` (HF≈1.72 < 1.87) and 3× is `health-factor` blocked (HF≈1.29 <
   1.7) at all equities (expected). SPEC005 continuous WARN at HF≈1.29 describes a *live* aggressive
   position, not a peer default capacity row.
2. **Net-APY snapshot** at canonical equity (default **100 DIEM**) across those leverages — model
   net APY at that size, **not** "what capital will earn." Inherits SPEC002 §8 caveats banner.
   Stress net APY is shown. Positive net APY at 100 DIEM with capacity 0 at large size is a valid
   joint outcome — do not imply "APY good ⇒ room for large capital."
3. **Deltas vs the previous *comparable* brief run** stored in SQLite.

### 3.2 Persistence (`Storage`)

```sql
CREATE TABLE IF NOT EXISTS brief_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  block_number INTEGER,              -- null when not from-chain
  chain_id INTEGER,
  input_mode TEXT NOT NULL,          -- from-chain | explicit-flags | offline-defaults
  authoritative INTEGER NOT NULL,    -- 0/1
  persistable INTEGER NOT NULL,      -- 0/1; offline-defaults = 0
  template_fingerprint TEXT NOT NULL,-- hash of leverage grid + gate flags + input mode
  payload_json TEXT NOT NULL         -- full BriefSnapshot JSON (bigints as strings)
);
CREATE INDEX IF NOT EXISTS brief_runs_ts ON brief_runs(timestamp DESC, id DESC);
```

- `insertBriefRun(snapshot)` only when `persistable === true` (from-chain or explicit-flags success).
- `getLatestComparableBriefRun({ inputMode, templateFingerprint })` → previous row with the **same**
  `inputMode` + `templateFingerprint` and `persistable = 1`, else `null`.
  Order: `ORDER BY timestamp DESC, id DESC`.

**`templateFingerprint` preimage (normative — stable JSON, sorted keys, then hash):**
`inputMode`, leverage grid (bps list), `canonicalEquityDiem`, and every gate/fee knob that alters
`sizeLoopScenario` when changed by flag/config for this run: `minHealthFactorBps`, `minNetApyBps`,
`maxSlippageBps`, `maxMorphoUtilizationBps`, `maxCurvePositionShareBps`, `holdingPeriodDays`,
`gasCostDiem`, `curveFeeBps`, `flashFeeBps`, `exitRepayBufferBps`, `lltvBps`, `borrowRateModel`.
**Exclude** live market legs / Morpho supply / existing borrow / rateAtTarget / vaultApy — those
must move numeric deltas, not invalidate the baseline fingerprint.

**Do not** reuse `metric_snapshots` for this.

`BriefSnapshot` (stored + emitted core; bigints as strings on disk):

```ts
interface BriefSnapshot {
  timestamp: number;
  blockNumber: string | null;
  chainId: number;
  inputMode: "from-chain" | "explicit-flags" | "offline-defaults";
  templateFingerprint: string;
  persistable: boolean;
  rateAtTargetApyBps: number | null;
  effectiveBorrowApyBpsAtCanonical: Record<string /* lev bps */, number>;
  vaultApyBps: number | null;
  vaultApySource: "measured-7d" | "not-seeded" | "flag" | null;
  curveDiemLegDiem: string | null;
  curveWstDiemLegDiem: string | null;
  morphoSupplyDiem: string | null;
  morphoExistingBorrowDiem: string | null;
  morphoRawAvailableDiem: string | null;
  capacities: Array<{
    targetLeverageBps: number;
    capacityEquityDiem: string;
    capacityNotionalDiem: string;
    headroomToBlockEquityDiem: string;
    capacityStatus: string;
    bindingConstraint: string;
  }>;
  netApyAtCanonical: Array<{
    targetLeverageBps: number;
    equityDiem: string;
    netApyBps: number;
    netApyStressedBps: number;
    status: string;
  }>;
  authoritative: boolean;
  warnings: string[];
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];
  disclaimer: string;
}
```

### 3.3 Delta computation

```ts
interface BriefDeltas {
  rateAtTargetApyBps: number | null;
  vaultApyBps: number | null;
  morphoRawAvailableDiem: string | null;     // signed bigint string
  curveDiemLegDiem: string | null;
  perLeverage: Array<{
    targetLeverageBps: number;
    capacityEquityDiem: string | null;       // signed bigint string
    capacityNotionalDiem: string | null;
    netApyBps: number | null;
    capacityStatusTransition: string | null; // "candidate → blocked" when differs; else null
    bindingConstraintTransition: string | null;
  }>;
  incomparable: boolean;                     // true → all numeric deltas null
  incomparableReason?: string;               // e.g. BRIEF_BASELINE_INCOMPARABLE
}
```

Rules (JSON shape is pinned — no dual form):
- No previous comparable row (`getLatestComparableBriefRun` returns null) → `previous = null`,
  `deltas = null`. Render `n/a`, **never** `0`. This covers first run and “history exists but no
  matching mode+fingerprint.”
- Same mode+fingerprint: `deltas` is a fully populated `BriefDeltas` with `incomparable: false`;
  `deltaX = current.x − previous.x` for numerics; bigint deltas as signed strings; missing leverage
  row on one side → that row's numeric deltas `null` (not `0`).
- Status/constraint: `previous → current` when they differ; else `null`.
- `incomparable: true` is reserved only if a baseline row was loaded then rejected by a secondary
  check (should not happen if the query is correct); normal path never needs it.

### 3.4 `loop brief` result shape

```ts
interface LoopBriefResult {
  current: BriefSnapshot;
  previous: BriefSnapshot | null;
  deltas: BriefDeltas | null;
  capacities: LoopCapacityResult[];
  netApyGrid: LoopSizingResult[];
  authoritative: boolean;
  warnings: string[];
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];
  disclaimer: string; // capacity disclaimer + fixed brief suffix below
}
```

Brief disclaimer = capacity `disclaimer` + exact suffix:

> `" Deltas are vs this tool's last comparable stored brief run on this SQLite file (same input mode and template), not vs a market benchmark."`

### 3.5 CLI

```text
loop capacity
  --target-leverage <value>          # optional SINGLE leverage > 1; default 1.5
                                     # comma grid → INVALID_INPUT (multi-L is loop brief only)
  --from-chain                       # live seed (recommended for capital numbers)
  --planning-block <n>
  --allow-offline-defaults           # escape hatch; non-authoritative; not persistable as capital baseline
  # sizing seed / fee / gate flags forwarded into the template
  --json

loop brief
  --target-leverage <values>         # comma grid; default "1.5,1.8"
  --canonical-equity-diem <amount>   # default 100
  --from-chain
  --planning-block <n>
  --allow-offline-defaults
  --json
  # same seed/fee/gate flag surface
```

**`--from-chain` is NOT default-on** (hermetic tests; no surprise RPC). Without it, either explicit
market flags or `--allow-offline-defaults` is required (§2.7).

**Refuse / error codes (pinned):**
- Offline fantasy refuse (§2.7) → `CliError("OFFLINE_CAPACITY_REFUSED", …)` (not a silent capacity 0).
- Multi-leverage on `loop capacity` → `CliError("INVALID_INPUT", …)`.
- Seed/RPC hard fail → existing `FROM_CHAIN_SEED_BLOCKED` / tool-error class.

**Exit codes.** Advisory: `0` on success, `1` on tool/seed/refuse error. Do **not** reuse SPEC004
codes — these commands assess no live *position* danger. Do not emit `outcome`/`exitCode` fields.

**Storage.**
- **Capacity `--from-chain`:** open `Storage` **read-only for vault APY window** (same as sizing
  Part B-2) so capacity and brief share vault APY; **never** write `brief_runs`. Close in `finally`.
- **Brief:** open Storage; on success with `persistable` insert; close in `finally`. Refuse / seed
  failure → no insert.

## 4. Integration points (file:line anchors at authoring time)

| Concern | Where |
|---|---|
| Capacity search | **new** `src/loop/capacity.ts` — pure search over `sizeLoopScenario`; injectable block-pinned quoter |
| Seed reuse | `src/loop/fromChainSeed.ts` — shared "seed + template" helper (incl. vault APY when store provided); export get_dy helper or inject from CLI — do not use private symbols |
| CLI | `src/cli/index.ts` — `loop capacity` + `loop brief` |
| Render | `src/cli/output.ts` — `renderLoopCapacityTable`, `renderLoopBrief`; banner **above** the number |
| JSON | existing `stringifyJson` |
| Storage | `src/storage/sqlite.ts` — `brief_runs` + insert / getLatestComparable |
| Shortfalls / status | `src/loop/sizing.ts` — **read only** |
| Exit codes | **not** `exitCode.ts` |

**Human banner (required, above the number):**
`inputMode` token (`CHAIN-SEEDED` / `EXPLICIT FLAGS` / `OFFLINE DEFAULTS`) + disclaimer one-liner +
last-candidate gloss: `Gates clear up to E @ L× (notional N). Next: <status> via <constraint>. Not a deploy recommendation.`
When `search.truncated`, append `search truncated`. When unbounded, use `≥ maxProbe` wording.

## 5. Fail-closed & honesty

1. **Seed/RPC/hard get_dy failure → no capacity number.** Never emit `capacityEquityDiem: 0` as a
   stand-in for "could not read."
2. **Drained pool — split:**
   - Offline / explicit legs `0/0` → capacity 0 / `blocked` / curve binding (AC1).
   - `--from-chain` empty pool → existing SPEC003 seed **error**, no report (do not soft-zero).
3. **Degraded seed → `authoritative: false`** + unverified token on rendered edge status (SPEC003 §6).
4. **Offline refuse** without market inputs or escape hatch (§2.7).
5. **No concurrent-flow model** — caveat only.
6. **Framing.** Structured honesty fields + fixed disclaimer on every result. Renderers put the
   banner above the number. Language: "gates clear up to …", never "deploy up to …".
7. **Not a solicitation.** The brief is an operator/cron artifact; it does not recommend sizing up.

## 6. Interactions & backward-compat

- **SPEC002 / sizing:** pure consumer. No field renames, no gate changes, no new blockers.
- **SPEC003 / from-chain:** reuses seed + get_dy demotion; capacity is a new consumer of seeds.
- **SPEC004 / exit codes:** untouched.
- **SPEC005 / liquidation:** untouched. Note only: default brief leverages stay in the healthy
  entry band; 3× under default min HF → capacity 0 / `health-factor`.
- **`--json` consumers of `loop sizing`:** unchanged. New commands only.
- **SQLite:** additive table; existing DBs migrate via `CREATE TABLE IF NOT EXISTS`.

## 7. Acceptance criteria (tests when built)

1. **Drained pool (offline/explicit legs 0/0) → capacity 0 / blocked.** Binding ∈
   {`curve-exit-slippage`, `curve-depth`}.
2. **Morpho-bound capacity.** Deep curve, tight Morpho; capacity within `searchResolutionDiem` of
   the largest candidate `E` with `borrowAmountDiem ≤ availableMorphoBorrowDiem`;
   `bindingConstraint === "morpho-util-headroom"`.
3. **Curve-slippage-bound capacity.** Fixture where exit-slippage is the first blocker; binding
   `"curve-exit-slippage"`.
4. **Monotonicity (gas = 0).** If equity `E` is non-candidate then every larger ladder `E'` is
   non-candidate on the fixture.
5. **Gas non-monotone path.** Large fixed `gasCostDiem` blocks tiny equities on `net_apy`; search
   still finds positive capacity when mid-size candidates exist.
5b. **Narrow candidate island between ladder rungs.** Construct candidate-only band between `2^k`
    and `2^{k+1}` (gas floor + curve ceiling); search must return capacity > 0 (island bisect).
6. **HF-only block → capacity 0.** High leverage with structural HF < min → capacity 0,
   `bindingConstraint === "health-factor"`.
6b. **3× under default min HF 1.7 → capacity 0 / health-factor** (documents OQ-A).
7. **bindingEdge shortfalls** present; JSON bigints are **strings**; `capacityNotionalDiem ===
   positionCollateralForScenario` at the capacity edge (not trunc product).
8. **get_dy re-quote per size + same block.** Injectable quoter sees distinct sizes; all calls share
   one `blockNumber`. Hard fail → no result; soft demote → continues non-authoritative.
9. **Degraded seed demotes.** `authoritative: false`; structured honesty fields present.
10. **Brief first run:** `previous === null`, `deltas === null`, render `n/a` (not `0`).
11. **Brief second run (comparable):** numeric deltas equal `current − previous` for capacity
    equity, rateAtTarget, vault APY, morpho raw available, net APY.
11b. **Incomparable baseline:** offline→live or fingerprint change → deltas null / incomparable,
     not a fake market move.
12. **Brief persistence:** only `persistable` runs insert; offline-defaults do not become capital
    baselines; `getLatestComparableBriefRun` respects mode+fingerprint; `ORDER BY timestamp DESC, id DESC`.
13. **`--json` envelope:** structured honesty fields required; disclaimer present; no SPEC004
    `outcome`/`exitCode`.
14. **Refuse offline fantasy:** without `--from-chain`, without explicit market flags, without
    `--allow-offline-defaults` → error, no capacity number.
15. **Human banner:** input mode + last-candidate gloss above the number; output must not contain
    `"deploy up to"`.
16. **Unbounded window:** still-candidate at maxProbe → binding
    `unbounded-in-search-window`; render `≥` wording.
17. **No SPEC004 regression:** `exitCode.ts` untouched; monitor suite still green.
18. **Capacity `--from-chain` vault APY parity:** with a store that has a measured window, capacity
    and brief see the same `vaultApyBps` seed path (capacity reads Storage, does not write brief_runs).

## 8. Open questions

- **[OQ-A — RESOLVED]** Default brief leverages = **`1.5,1.8`** (post-executor correction: 2× always
  sits in the HF proximity band under min HF 1.7 → last-candidate capacity identically 0). Capacity
  default leverage = **1.5**. 2×/3× opt-in; 3× → capacity 0 / `health-factor`.
- **[OQ-B — RESOLVED]** **Refuse** offline fantasy capacity/brief unless explicit market flags or
  `--allow-offline-defaults`. Offline-defaults are non-authoritative and non-persistable as capital
  baselines.
- **[OQ-C — RESOLVED]** Single leverage for `loop capacity`; multi via `loop brief`.
- **[OQ-D — RESOLVED / deferred]** No continuous refinement past 64 quotes / 0.01 DIEM; surface
  `search.truncated`.
- **[OQ-E — RESOLVED]** `headroomToBlock*` always-on in JSON; human table secondary line only.

## 9. Traceability

Each §7 criterion maps to tests in `test/capacity.test.ts` and/or `test/brief.test.ts` plus a small
compiled-CLI case (`test/cli-capacity.test.ts` or extension of `cli-sizing`). Roadmap Phase 7. No
SPEC001 OQ closed by this unit (OQ#3 Curve event ABI and OQ#8 threshold SoT remain open; OQ#7/#9
already closed by SPEC004/005).

## 10. Review-gate log

| Pass | Agents | Verdict | Folded |
|---|---|---|---|
| Pre-code #1 | technical critic + product analyst | both **REVISE** | Search pseudocode + maxProbe (C1); capacityEdge/bindingEdge split (C2); gas island bisect (C3); drop `"none"` (M1); `BriefDeltas` + comparability (M2/analyst#5); drained-pool split (M3); block-pin + revert/demote (M4/M5); capacity Storage read for vault APY (M6); notional = `positionCollateralForScenario` (M10); offline refuse (analyst C2/OQ-B); last-candidate buffer framing + structured honesty (analyst C1/C3); headroom-to-block secondary metric; morpho-util-headroom name; 3× entry-blocked note (OQ-A) |
| Confirmation | focused critic on deltas | **ACCEPT-WITH-RESERVATIONS** | M1 Step A order rewritten (island bisect before zero); M2 headroom notional = `positionCollateralForScenario`; M3 fingerprint preimage pinned; M4 capacity single-leverage reject; dual delta shape pinned; refuse code `OFFLINE_CAPACITY_REFUSED`; OQ-E resolved always-on JSON |
