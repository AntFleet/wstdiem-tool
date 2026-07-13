# SPEC008 — Demand indicator: NAV-ratchet yield velocity

**Status: REVIEWED + LOCKED (2026-07-13).** Two-agent pre-code gate (technical critic REVISE + product
analyst ACCEPT-WITH-RESERVATIONS) → fixes folded → focused confirmation ACCEPT-WITH-RESERVATIONS →
residual Majors M1–M5 folded → LOCKED. Ready for implementation.

> **Forward spec** (authored before implementation; acceptance criteria = the tests to write).
> **Conforms to** B-2 vault APY window patterns and SPEC001 A3 (decision-support only). **v1 = NAV
> velocity from stored samples** — self-contained. Harvest event reconciliation is **v2 deferred**.

## 1. Problem & scope

wstDIEM yield is demand-driven real yield downstream of DIEM inference demand (AskSurplus). This tool
cannot read AskSurplus — and does not need to: the vault's **NAV ratchet** is the on-chain
**coincident** proxy (never “leading AskSurplus demand”). Yield accrues into NAV; deposits/withdrawals
change supply and total assets but **not** NAV.

Today the only yield surface for sizing is B-2's **single lagging 7-day** window. There is no
**shorter-window NAV growth rate** or **acceleration** for the intelligence layer.

**Scope (v1).**

| Surface | Job |
|---|---|
| **`loop demand`** (CLI name; headline label is never bare “demand”) | From SQLite NAV samples (+ optional live tip), compute window annualized NAV growth, prior window, acceleration, non-annualized growth, paste-safe framing. |
| **Pure module** | `src/metrics/demand.ts` — pure over samples; no RPC required for DB-only. |
| **Storage** | `listNavSamplesForWindow` reading `metric_snapshots.nav` with **invalid-sample filter**. |

**Out of scope.** v2 harvest reconcile; `harvest_silence` wiring; changing B-2/`vaultApyBps`;
SPEC004 codes; brief attach (OQ-B = no); monitor alerts (OQ-D = no); X/funds/broadcast.

**Lexicon (normative).**
- Use **"NAV-ratchet yield velocity (demand proxy)"** in banners, table headers, paste lines.
- Ban: bare column “Demand”, “AskSurplus demand is…”, “leading AskSurplus”, “realized APY you will
  earn”, “demand is up”, “size larger”, “demand collapsed”.
- vs AskSurplus: **coincident/lagging proxy** (never leading).
- vs B-2 7d: **shorter-window yield-accrual signal** (not “leading demand”).

## 2. Why NAV, not totalAssets (load-bearing)

| Series | Changes on deposit? | Pure yield? |
|---|---|---|
| `vault_total_assets_diem` | Yes | **No** |
| `nav` | No | **Yes** |

Velocity uses **NAV only**. Using totalAssets is a spec defect.

### 2.1 Invalid sample filter (CRITICAL — dirty series)

`runWatchOnce` inserts snapshots even when the vault read failed; empty snapshot NAV is **WAD
(1.0)** (`makeEmptySnapshot`). Unfiltered tips produce false collapse/spike.

**Normative filter** for every sample entering demand math:

```text
validNavSample(row) ⇔ BigInt(row.nav) > 0n
  && BigInt(row.vault_total_assets_diem) > 0n   // empty/failed ticks write assets 0 + nav WAD
```

- `listNavSamplesForWindow` applies this filter **after** the anchor/`>` query.
- Live tip: only append if vault read set `validity.vault === true` and tip NAV > 0 and
  (when known) totalAssets > 0.
- AC: good history + failed tip with assets 0 / nav WAD → tip **skipped** with warning
  `invalid-nav-sample-skipped`; must not use WAD as endpoint.

(Optional later: write-path `insertMetricSnapshot` only when `validity.vault` — out of scope; filter
is sufficient for v1.)

## 3. Formulas, units, windows

### 3.1 Sample series

```ts
interface NavSample {
  timestamp: number;
  nav: bigint; // WAD
}
```

Query shape mirrors vault assets (anchor ≤ start + rows `timestamp > start`), then filter invalid,
then **window-bound** for density: only samples with `timestamp ≤ windowEnd` count for that window.

Duplicate timestamps: keep last by `ORDER BY timestamp ASC, id ASC` (include `id` in SELECT).

### 3.2 Windows

| Window | Default | Role |
|---|---|---|
| **current** | **`VELOCITY_WINDOW_SECONDS = 72h`** (259_200) | Headline velocity (OQ-A honesty default) |
| **prior** | same length, immediately before current | Acceleration |
| **reference7d** | `YIELD_WINDOW_SECONDS` | Always **attempt**; side panel when available |

```text
currentEnd = nowSeconds
currentStart = nowSeconds - W
priorEnd = currentStart
priorStart = currentStart - W
```

CLI `--window-hours <n>`: **integer** 1..168 (reuse strict integer parse). Default **72**.
Outside → `INVALID_INPUT`.

When `windowSeconds ≤ 48h` (172_800): always push caveat `short-window-noisy` and force
`authoritative: false` (§6).

### 3.3 Endpoint pick

For `[start, end]`, evaluate statuses in this **strict order** (first match wins):

1. `navStart` = last **valid** sample with `timestamp ≤ start`. If none → **`no-anchor`**.
2. If `navStart.nav <= 0n` → **`invalid-nav`** (defensive; filter should already exclude).
3. `navEnd` = last **valid** sample with `timestamp ≤ end` and `timestamp > navStart.timestamp`.
   If none → **`insufficient-samples`** (missing endpoint).
4. `spanSeconds = navEnd.timestamp - navStart.timestamp`.
5. If `spanSeconds === 0` → **`zero-span`**.
6. If `spanSeconds < MIN_SPAN_SECONDS` (**3600**) → **`span-too-short`**.
7. Density: if `countDemandSamples < MIN_DEMAND_WINDOW_SAMPLES` → **`insufficient-samples`**.
8. Else → **`ok`**.

**Density (pure helper — do NOT use unfiltered `list.length`):**

```text
countDemandSamples(samples, start, end) =
  |{ s ∈ samples : start < s.timestamp ≤ end }|
  + (1 if ∃ valid sample with timestamp ≤ start else 0)
  // pre-start anchor counts — not only timestamp === start
```

`sampleCount` on the window **is** this count. Require:

```text
MIN_DEMAND_WINDOW_SAMPLES = 2   // endpoint math minimum (not B-2's TWA floor of 4)
```

Prior window density **must not** count current-window samples (end-bound at `priorEnd`).

### 3.4 Rates

Import `SECONDS_PER_YEAR` from `math.ts` (31_536_000). Simple annualization on **observed** span
(not B-2's fixed 365/7 factor — same *style*, different model; say so).

```text
delta = navEnd.nav - navStart.nav
growth = delta >= 0
  ? ratio(delta, navStart.nav)
  : -ratio(navStart.nav - navEnd.nav, navStart.nav)   // never ratio(_, 0); navStart>0 gated
windowGrowthBps = Math.round(growth * 10_000)          // NOT annualized — paste honesty
velocity = growth * (SECONDS_PER_YEAR / spanSeconds)
velocityBps = Math.round(velocity * 10_000)            // pin Math.round
```

**Always** bigint delta then `ratio(absDelta, navStart)` — never `Number(navEnd)/Number(navStart)-1`.

**Worked anchors (tests):**
1. `1.00e18 → 1.001e18`, span 86400 → `windowGrowthBps = 10`, `velocityBps = 3650`.
2. NAV decline: `1.001e18 → 1.00e18`, span 86400 → negative `windowGrowthBps` and `velocityBps`.

### 3.5 Acceleration

Both windows `status === "ok"`:

```text
accelerationBps = current.velocityBps - prior.velocityBps
```

Else `accelerationBps = null` (render `n/a`, never `0`).

**Gloss enum** (JSON + table):

| Condition | `accelerationGloss` |
|---|---|
| prior/current not both ok | `null` |
| `current.velocityBps < 0` | `"negative-nav-move-investigate-not-demand-collapse"` |
| both > 0 and acc < 0 | `"decelerating-but-still-positive-proxy"` |
| acc > 0 | `"accelerating-proxy"` |
| acc < 0 | `"decelerating-proxy"` |
| acc === 0 | `"flat-proxy"` |

If prior ok and `|accelerationBps| > max(|prior.velocityBps|, 500)` → warning
`acceleration-cadence-artifact-possible`.

### 3.6 Flat zero ≠ zero demand

When current `status === "ok"` and `velocityBps === 0` (or `windowGrowthBps === 0`):

- push warning code `flat-nav-not-zero-demand` with message  
  `"NAV flat in window (proxy); not a measure of AskSurplus activity"`  
  (and if credit sum is `"0"`, append `" — no credit inflow observed; harvest lag possible"`).
- Do **not** put this text in `accelerationGloss` (that field is only the §3.5 enum).

### 3.7 Credit inflow (informational)

After `listCreditSamplesSince(currentStart)`:

```text
creditInflowDiem = sum amount where currentStart < timestamp ≤ currentEnd
```

- Readable store + sum 0 → `"0"` (string bigint).
- Store error → `null`.
- Label always: `FeeRouter→vault credits; not NAV rate; not AskSurplus volume`.
- **Must not** change `velocityBps` or invent `creditApy*`.

### 3.8 Live tip (`--from-chain`)

1. `collectVaultMetrics`; if `!validity.vault`, skip tip + warning.
2. Tip NAV = **`convertToAssets(1e18)`** (read separately if needed — **not** `snapshot.nav`, which is
   `totalAssets/totalSupply` only).
3. If convert fails → fallback `snapshot.nav` + warning `live-tip-nav-fallback-totals`.
4. If convert ≠ `computeNav` totals → warning `live-tip-nav-source-mismatch`, demote authoritative.
5. Append only if tip passes invalid filter. Memory-only (no `insertMetricSnapshot` on this path).

## 4. Result shape

```ts
type DemandWindowStatus =
  | "ok"
  | "insufficient-samples"
  | "no-anchor"
  | "zero-span"
  | "span-too-short"
  | "invalid-nav";

interface DemandWindow {
  status: DemandWindowStatus;
  windowStart: number;
  windowEnd: number;
  spanSeconds: number | null;
  sampleCount: number;
  navStart: string | null;
  navEnd: string | null;
  windowGrowthBps: number | null; // non-annualized
  velocityBps: number | null;     // annualized simple
  velocity: number | null;
}

interface LoopDemandResult {
  nowSeconds: number;
  windowSeconds: number;
  current: DemandWindow;
  prior: DemandWindow;
  reference7d: DemandWindow; // always materialize (status may be not-ok)
  accelerationBps: number | null;
  accelerationGloss: string | null;
  creditInflowDiemCurrent: string | null;
  sampleSource: "sqlite" | "sqlite+live-tip";
  // Paste safety
  headlineLabel: "nav-ratchet-yield-velocity-bps-annualized-proxy";
  pasteLine: string; // see exact template below
  // Honesty
  decisionSupportOnly: true;
  notAYieldPromise: true;
  demandKind: "nav-ratchet-yield-velocity-proxy";
  modelCaveats: string[];
  disclaimer: string;
  warnings: string[];
  authoritative: boolean;
}
```

**`pasteLine` template (exact when current ok):**

> `NAV-ratchet yield velocity (demand proxy): {velocityBps} bps annualized simple over observed {observedHours}h span (configured window {configuredHours}h; window growth {windowGrowthBps} bps) — not AskSurplus demand; not a yield promise; decision-support only`

- `observedHours = round(spanSeconds / 3600)` (from current window).
- `configuredHours = windowSeconds / 3600`.
- When current not ok: same skeleton with `n/a` for numeric slots.

**`disclaimer` (fixed):**

> `"NAV-ratchet yield velocity is an on-chain coincident proxy of inference demand (vault share-price growth), not AskSurplus demand itself and not a yield promise. Short windows are noisy; harvest cadence is irregular; flat NAV is not zero AskSurplus activity. Deposits do not move NAV — this series isolates yield from flows. Decision-support only; the operator must decide out-of-band."`

**`modelCaveats`:** `nav-not-total-assets`, `short-window-noisy` (when ≤48h), `irregular-harvest-cadence`,
`proxy-not-asksurplus`, `simple-annualization-observed-span`, `requires-sqlite-history`,
`spec008-v1-no-harvest-reconcile`, `flat-nav-not-zero-demand` (when applicable).

## 5. CLI & integration

```text
loop demand
  --window-hours <n>   # integer 1..168; default 72
  --json
  --from-chain         # optional live tip append (memory only)
```

- Storage always open (read). DB empty → exit **0**, windows not-ok, velocities null.
- Invalid flags / storage open fail → exit **1**.
- No SPEC004 fields; do not touch `exitCode.ts`.

**Render:** banner above numbers with disclaimer + sampleSource + noise label if ≤48h; columns
**`NAV velocity (proxy) bps`**, window growth bps, hours on same row; acceleration gloss; credit
labeled; ban-list AC on output strings.

**Brief:** **do not** attach demand in this unit (OQ-B locked).

## 6. `authoritative` predicate (pinned)

```text
MIN_AUTHORITATIVE_SPAN = min(windowSeconds, 24 * 3600)   // e.g. 24h of observed span for W≥24h

authoritative =
  current.status === "ok"
  && prior.status === "ok"
  && windowSeconds > 48 * 3600
  && current.spanSeconds >= MIN_AUTHORITATIVE_SPAN
  && prior.spanSeconds >= MIN_AUTHORITATIVE_SPAN
  && !warnings includes any of DEMOTING_CODES
```

`DEMOTING_CODES` = {
  `short-window-noisy`,
  `live-tip-nav-source-mismatch`,
  `live-tip-nav-fallback-totals`,
  `invalid-nav-sample-skipped`,   // live tip only — historical filter is silent
  `nav-declined-in-window`,
  `acceleration-cadence-artifact-possible`
}

**Not demoting:** `flat-nav-not-zero-demand` — flat NAV is trustworthy arithmetic between harvests;
it stays a warning + caveat only.

Meaning: **enough clean history and observed span to trust the arithmetic under this tool's rules** —
**not** “AskSurplus-validated demand.” Document that in the banner.

Default 72h can be authoritative when both windows ok, observed spans cover ≥24h each, and no
demoting warnings. 24h opt-in is always non-authoritative (≤48h rule).

## 7. Fail-closed & honesty

1. Missing/invalid → null/`n/a`, never seed 0 for missing.
2. Ok+0 → flat-nav warning (not “no demand”).
3. NAV-only; deposit fixture must show ~0 velocity.
4. Negative NAV move honest + `nav-declined-in-window`.
5. Paste line + long labels always present.
6. Credit never drives velocity.

## 8. Acceptance criteria

1. Worked: 1.00→1.001 / 86400s → `windowGrowthBps === 10`, `velocityBps === 3650`.
2. Acceleration: current 3650, prior 2000 → `accelerationBps === 1650`, gloss accelerating-proxy.
3. Insufficient samples → null velocities, status `insufficient-samples`.
4. No anchor → `no-anchor`.
5. **NAV not totalAssets:** deposit doubles assets/supply, NAV flat → velocity ≈ 0.
6. Negative NAV → negative bps + warning.
7. Prior missing → `accelerationBps === null` (not 0).
8. JSON: nav strings; pasteLine present; honesty fields; no outcome/exitCode.
9. Offline empty DB → exit 0, n/a; with samples → numbers; hermetic env.
10. `--window-hours` 0 or 200 → INVALID_INPUT exit 1; non-integer rejected.
11. Live tip uses convertToAssets; mismatch demotes; invalid tip skipped.
12. Boundary: no double-count at windowStart; prior density ignores current samples.
13. Ok+0 velocity → `flat-nav-not-zero-demand` warning.
14. `windowSeconds ≤ 48h` → `authoritative === false` + `short-window-noisy`.
15. Polluted tip (assets 0, nav WAD) skipped.
16. span < 3600 → `span-too-short`, null velocity.
17. Ban-list render strings absent.
18. Credit present does not change velocityBps; no creditApy fields.
19. `exitCode.ts` untouched; suite green.
20. Default CLI window hours === 72.
21. Pre-start anchor + one in-window point, span ≥ 3600 → density ≥ 2, can be `ok`.
22. Configured 72h but observed span 3600 → not authoritative; paste shows observed hours, not only 72.
23. Ok + zero velocity still may be authoritative when spans and density pass (flat does not demote).

## 9. Open questions (resolved)

- **[OQ-A — RESOLVED]** Default **72h**; 24h opt-in noisy/non-authoritative.
- **[OQ-B — RESOLVED]** No brief attach in this unit.
- **[OQ-C — RESOLVED]** Harvest reconcile deferred; credit sum informational only.
- **[OQ-D — RESOLVED]** No monitor WARN on negative velocity in v1.

## 10. Traceability

`test/demand.test.ts` (+ CLI cases). Roadmap Phase 9. No SPEC001 OQ closed.

## 11. Review-gate log

| Pass | Agents | Verdict | Folded |
|---|---|---|---|
| Pre-code #1 | technical critic + product analyst | REVISE + AWR | Invalid sample filter; density=2 + min span 3600; default 72h; convertToAssets tip; prior density end-bound; invalid-nav status; authoritative predicate + demoting codes; pasteLine/windowGrowthBps; flat-zero gloss; accel gloss; credit predicate; no brief; ban list ACs |
| Confirmation | focused critic | **ACCEPT-WITH-RESERVATIONS** | M1 density counts pre-start anchor; M2 navEnd→insufficient-samples + status order; M3 paste observed vs configured hours + authoritative min span coverage; M4 flat-nav not demoting; M5 flat text in warnings not accelerationGloss |
