# SPEC001 ⇄ as-built reconciliation (drift ledger)

Phase 1 of the spec-first roadmap. Maps every SPEC001 section to what the CLI actually does today,
so the rev-2 rewrite is grounded in evidence rather than aspiration. Verified against source
2026-07-11 (HEAD `6e6ea2e`).

**Legend**
- ✅ **built-as-spec** — code matches the spec.
- 〜 **built-differently** — exists but diverges; spec needs a truth-update.
- ✖ **spec-not-built** — specified, never implemented.
- ＋ **built-not-spec** — implemented, absent from the spec.

**Locked decisions applied:** D1 exit-only is current (open/rebalance → deferred appendix);
D2 drop the persistent `watch` daemon/TUI (standardize `watch --once` + scheduler); D3 keep
broadcast fail-closed (document the gate, defer the enablement spec).

---

## Section-by-section

### Preamble / source-derived constraints (lines 1–24)
| Item | Status | Evidence / rev-2 action |
|---|---|---|
| Source pinned to `liquid-protocol-v0` @85fb070; `totalSupply()` as shares; infer `creditDIEM` from logs; vault addresses config-required | ✅ | Still accurate. Keep; refresh the "source revision" note to the v6 redeploy already pinned in §Open-Q1. |

### §1 Data Sources
| Clause | Status | Evidence / rev-2 action |
|---|---|---|
| Core ABIs: InferenceVault, FeeRouter, CurvePool, Morpho, IRM, Oracle | ✅ | `src/abi/{inferenceVault,feeRouter,curvePool,morpho,morphoIrm,morphoOracle,erc20,loopExecutor}.ts` |
| `AgentTGERegistry`, `SurplusStakingWrapper`, `WstDIEMHook` interfaces | ✖ | No ABI, no reads. **Cut** from rev-2 (out of scope for the loop operator) or move to a "not-consumed" note. |
| Event schemas (harvest, Transfer, Surplus, CurveTokenExchange) | 〜 | `metrics/backfill.ts` consumes a subset; Surplus events unused. Trim to what's read. |
| Reads-and-polling table with 15s/30s/60s/5m cadences | 〜 | The reads exist; the **cadence assumes a daemon that doesn't exist** (only `watch --once` + `status` + `monitor`). Reframe as "reads per invocation," drop interval columns (D2). |

### §2 Computed Metrics
| Clause | Status | Evidence |
|---|---|---|
| NAV, baseAPY (7d window), utilization, borrowRate=exp(perSec·yr)−1, netAPY, healthFactor, positionSizeVsCurveDepth, oracleDeviation | ✅ | `metrics/math.ts` (`computeBaseApy`, `computeNetApy`, `computeUtilization`, `computeBorrowRate`), `metrics/collector.ts`. Keep ~verbatim; this section is accurate. |

### §3 Alert System
| Clause | Status | Evidence / action |
|---|---|---|
| Alert table (HF, spread, curve-depth, harvest-silence, oracle, borrow-spike, RPC-stale, sim-failure) + dedup key | ✅/〜 | `alerts/evaluate.ts`, `monitor/readinessAlerts.ts`. Verify each row's threshold wiring in rev-2; alerts fire via `monitor --alert`, not a daemon. |
| Delivery: stderr(chalk), webhook, Telegram | 〜 | `alerts/deliver.ts` via `undici`; **`telegraf` is NOT a dependency** — Telegram (if built) is raw HTTP. Update §10 + this claim. |

### §4 Watch Mode — **largest drift** (D2)
| Clause | Status | Evidence / action |
|---|---|---|
| Persistent daemon, startup sequence, dashboard rows, graceful shutdown | ✖ | Persistent path **throws** `NOT_IMPLEMENTED` (`cli/index.ts:162`). **Rewrite** around `watch --once` + external scheduler. |
| `eth_subscribe` WebSocket listeners + reorg-overlap backfill | ✖ | Polling/backfill only (`metrics/backfill.ts`); no subscriptions. Move to a deferred note. |
| SQLite schema (8 tables) | ✅ | `storage/sqlite.ts` — all 8 present. Keep. |
| `alert_state` table (cooldown/dedup) | ＋ | Exists beyond the spec's 8 tables. **Add** to rev-2 schema. |
| Dashboard content | 〜 | Rendered by `status`/`monitor` one-shot, not a live TUI (`ink`/`react` absent). Re-attribute to those commands. |

### §5 Loop Service
| Sub-command | Status | Evidence / action |
|---|---|---|
| `loop open` (full flash-loan broadcast, `LoopOpenParams`, atomic 12-step sequence) | ✖ (current) | Dead-gated: `params.ts:93` marks `open` unsupported; `cli/loop.ts:240` throws before broadcast. **Move to "Deferred — multi-action executor" appendix (D1).** |
| `loop rebalance` (+ partial-unwind formula) | ✖ (current) | Same — **deferred appendix (D1).** |
| `loop authorize-executor` | ✅ | `loop/authorization.ts` + `cli/index.ts:514` (reads `isAuthorized`, builds `setAuthorization`, `--live`/`--dry-run`). Keep; note broadcast still gated (D3). |
| `loop exit` — "current product slice" notes (lines 691–697) | ✅ | Already describes the as-built exit-only simulation. Keep, promote to the primary exit spec. |
| `loop exit` — atomic broadcast sequence (lines 681–689) | ✖ | Broadcast disabled (D3). Frame as the deferred target behind the audit gate. |
| `loop readiness` + flash-provider fee proof + fork-test contract (lines 699–753) | ✅ | `loop/readiness.ts`, `loop/exitPlan.ts`, `loop/flashFeeProof.ts`, `loop/uniswapV3FlashFee.ts`, `test/foundry/*`. Accurate and detailed. Keep. |
| **`loop sizing`** | ＋ | **Entire offline sizing engine absent from SPEC001** (`loop/sizing.ts`, `sizingScenarios.ts`, `morphoRate.ts`, ~20 flags). → its own spec (**Phase 2 / SPEC002**); reference it here. |
| **`loop simulate --live`** composite flow | ＋ | `cli/index.ts:382` chains preflight→exit-plan→route-quote→flash-fee→simulate. Add as a first-class §5 command. |

### §6 Auto-Deleverager
| Clause | Status | Evidence / action |
|---|---|---|
| Resolver condition, repay math, `AutoDeleverageExecutorContract`, daemon automation monitoring | ✖ | `autoDeleverageExecutor: null`; no resolver, no contract, no daemon. **Move to deferred appendix** (needs both a deployed contract and the daemon — neither exists). |

### §7 Configuration
| Clause | Status | Evidence / action |
|---|---|---|
| YAML schema (chainId, rpc, contracts, morpho, wallet, position, thresholds, alerts, automation, storage, execution) | ✅ | `config/defaults.ts` + `config/load.ts` (zod). Matches closely. |
| `flashLoan` config block | ＋ | Referenced in §5 but **missing from the §7 schema**; exists in code (`config/defaults.ts:71`, `types/domain.ts:82`). **Add** the block to §7. |
| `automation.provider: gelato`, `autoDeleverageExecutor` | 〜 | Present but inert (no automation built). Keep as config, mark inert/deferred. |

### §8 CLI Interface — **needs a full refresh**
| Row | Status | Evidence / action |
|---|---|---|
| `watch` "Persistent daemon and TUI" | 〜 | Only `--once`. Reword. |
| `status` | ✅ | Keep. |
| `loop open`, `loop rebalance` | ✖ (current) | Mark deferred (D1). |
| `loop readiness` | 〜 | Add real flags `--loop-executor`, `--strict-evidence` (`cli/index.ts:285`). |
| `loop authorize-executor` | 〜 | Add `--live`. |
| `loop exit` | 〜 | Broadcast-disabled; simulate-only today. |
| `loop simulate` | 〜 | Under-specified; add `--action`, `--live`, `--force`. |
| `loop history --since` | ✖ | Only `--limit` built (`cli/index.ts:604`). Drop `--since` or mark unbuilt. |
| `alerts test --channels` | ✖ | Only `--severity`/`--message` (`cli/index.ts:623`). Drop `--channels` or mark unbuilt. |
| **`monitor`** | ＋ | Built (`cli/index.ts:176`), **absent from the table**. Add. |
| **`loop sizing`** | ＋ | Built, **absent from the table**. Add (spec detail → SPEC002). |

### §9 Error Handling & Safety
| Clause | Status | Evidence / action |
|---|---|---|
| RPC retry/backoff (`min(30s,500·2^a)+jitter`, 5 reads / 1 broadcast), failover, highest-finalized-block | 〜 | Failover/health-check in `contracts/rpc.ts` (audit: **untested**; exact params unverified). Reconcile to actual constants; flag test gap. |
| Broadcast rules (never-broadcast-on-revert, `pending_unknown`, `--force-gas` future) | ✖ (moot) | Broadcast disabled (D3). Keep as the deferred broadcast contract. |
| Executor safety (reentrancy, callback-sender, owner-auth, dust refund) | ✅ | Describes `contracts/LoopExecutor.sol`; enforced + fork-tested. Keep. |

### §10 Tech Stack
| Clause | Status | Evidence / action |
|---|---|---|
| viem, commander, zod, yaml, better-sqlite3, cli-table3, chalk, pino, undici, vitest | ✅ | Present. |
| `ink` + `react` (TUI) | ✖ | **Absent** from deps (D2 daemon dropped). Remove. |
| `telegraf` (Telegram) | ✖ | **Absent**; delivery is raw `undici`. Update. |
| `@ledgerhq/*` hardware wallet | ✖ | **Absent**. Move to deferred/optional. |
| Testing split + Foundry commands (`test:contracts{,:fork}`, `readiness:owner`, `proof:full-unwind`) | ✅ | Matches `package.json` scripts + `test/foundry/*`. Keep. |

### §Open Questions
| Q | Status | Action |
|---|---|---|
| Q1 addresses pinned to v6; Q2 flash provider selected | ✅ resolved | Fold into the body as settled facts. |
| Q3 open route, Q5 TokenExchange ABI, Q6 hardware wallet, Q7 riskFreeRate | ✖ open | Keep; re-scope Q3/Q6 as deferred-feature questions. |

---

## The rev-2 shape (what changes)

1. **Retitle** to reflect reality: an **offline-first, exit-only, broadcast-disabled** operator CLI.
2. **§4 Watch** → rewrite around `watch --once` + external scheduler; demote daemon/TUI/`eth_subscribe` to a "Deferred" appendix.
3. **§5 Loop** → exit + readiness + authorize + simulate as the current surface; **`open`/`rebalance`/broadcast/auto-deleverager → Deferred appendix**.
4. **Add the two built-but-unspecified commands**: `monitor` (full spec) and `loop sizing` (stub → SPEC002).
5. **§7** add the `flashLoan` block; **§8** rebuild the command table to match code; **§10** drop `ink`/`react`/`telegraf`/ledger.
6. **Drop unbuilt flags** (`loop history --since`, `alerts test --channels`) or mark them explicitly deferred.
7. Add a short **"Deferred (not in the current tool)"** appendix collecting: multi-action executor (open/rebalance), broadcast enablement (behind the audit gate), auto-deleverager, persistent daemon/TUI, hardware wallet.

**Net:** ~40% of SPEC001 describes an unbuilt future (daemon, broadcast, multi-action, auto-deleverager). rev-2 keeps that as an explicitly-labeled Deferred appendix and makes the main body a true description of the shipping tool.

---

## Post-review corrections (2026-07-11)

rev-2 went through a two-agent review gate (adversarial technical + product-design). The technical
reviewer found — and I verified against code — that rev-2 (and this ledger) had **carried over
original-spec text without checking the ABIs**. Corrected in rev-2:

| Finding | Was | Now | Evidence |
|---|---|---|---|
| §1 fabricated vault/FeeRouter/Curve reads | listed methods not in the ABIs | trimmed to actual ABI (vault: 4 fns; FeeRouter: events only; Curve: `balances`+`get_dy`) | `src/abi/{inferenceVault,feeRouter,curvePool}.ts` |
| §9 RPC backoff | `min(30s,500·2^a)+jitter` | 5 immediate retries, no backoff (accurate) | `src/contracts/rpc.ts:42-67` |
| §7 `maxBaseApyStalenessBlocks` | 43200 | 7200 | `config/defaults.ts:87`, test-locked |
| §6 `alert_state` DDL | `(alert_key, last_delivered_at, last_level)` | `(dedupe_key, last_delivered_at)` | `sqlite.ts:111` |
| §6 `metric_snapshots` | missing column | added `vault_total_assets_diem` | `sqlite.ts:126` |
| §3 alert attribution | "evaluated by … monitor" | `monitor` uses a disjoint readiness-alert set | `readinessAlerts.ts` |
| §5 `authorize-executor --owner` | "defaults wallet address" | defaults to `config.position.owner` | `index.ts:527` |
| §10 deps | `@morpho-org` optional; no `dotenv` | `@morpho-org` absent; `dotenv` present | `package.json` |
| §7 contracts | missing `uniswapV4PoolManager` | added (inert) | `defaults.ts:22` |
| SPEC002 | "is specified" | "planned — not yet authored" | plan only |

**Ledger self-correction:** this ledger originally certified §1 as `✅ built-as-spec` — wrong; it
checked that ABI *files* exist, not that the spec's method lists match ABI *contents*. §1 is now
`built-differently` (over-listed reads, corrected).

The product reviewer's structural findings are **not spec-truth defects** but real product gaps,
surfaced as SPEC001 Open Questions #6–9: the interim exit-execution path (blocking), the scheduler
exit-code contract, threshold source-of-truth, and a liquidation readout. These need product
decisions, not edits.
