# wstDIEM Protocol Audits — Consolidated Findings

**Compiled:** 2026-07-13  
**Status of external audit:** **Not closed.** No third-party firm report is published. The production audit gate remains **CLOSED** (open/increase leverage blocked; exit/deleverage allowed).  
**Sources:** `~/wstdiem-internal-docs/audit/`, `~/wstdiem-internal-docs/STEP-7-AUDIT-CYCLE.md`, protocol `SECURITY.md` / `PROTOCOL.md` / `LAUNCH_READINESS.md`, project memory notes, and the loop-manager repo (`wstdiem`).

---

## Executive overview

| # | Date | Scope | Type | Verdict | C | H | M | Notes |
|---|------|--------|------|---------|---|---|---|-------|
| 1 | 2026-06-03 | Loop manager tool (`contracts/`, `src/`, `test/`) | Multi-agent code/security/architecture | Pre-prod OK; 0 C/H survived | 0 | 0 | 8 | 71 verified findings |
| 2 | 2026-06-11 | Launch specs SPEC002–004 | Spec internal audit | Clean after fixes | 0 | 0 | 2 | All fixed in same pass |
| 3 | 2026-06-12 | SPEC005 + THREAT-MODEL (Step 7) | Codex×2 + Claude adversarial | Spec fixed; would-not-sign-off pre-fix | ~5 | ~9 | ~8+ | Spec-stage substitute for external firm |
| 4 | 2026-06-12 | Phase A interface appendix | Codex×2 + Claude | Critical/High closed | 2 | 5 | 8 | Interface shapes + A1–A5 |
| 5 | 2026-06-12 | Round 2: SPEC↔appendix drift + AutomationExec attacker | Codex×2 + Claude | 8 Tier1/2 blockers closed | 3+ | many | many | AC-17 highest impact |
| 6 | 2026-06-17 | Protocol v6 monorepo (full implementation) | Tri-dimensional multi-agent | **Do not external-audit/launch** | 1 | 19 | 36 | 118 confirmed; report path may be missing |
| 7 | 2026-06-16+ | PR-level (PR-11, PR-16, PR-17, PR-19) | Compliance + adversarial | Integrated per PR | — | — | — | Fix-list workflow |
| 8 | ongoing | External firm audit | Third-party | **Not done / not published** | — | — | — | Gate closed until done |

**Bottom line:** Multiple **internal AI-driven audits** have been run and largely integrated into specs and code. **No independent external security firm audit report** is available. Protocol `SECURITY.md` states reports will land under `audit/` once available. `LAUNCH_READINESS.md` still lists **T10. External audit gate closed** as a blocker.

---

## 1. Loop manager tool audit — 2026-06-03

**Full report:** [`~/wstdiem-internal-docs/audit/AUDIT-2026-06-03.md`](file:///Users/augstar/wstdiem-internal-docs/audit/AUDIT-2026-06-03.md)  
**Scope:** Entire then-current loop-manager codebase (`contracts/LoopExecutor.sol`, TypeScript operator CLI, tests).  
**Method:** 12 specialist finders × adversarial verifiers; ~90 agents; 75 raised → 71 survived (4 refuted).

### Summary counts

| Dimension | Critical | High | Medium | Low | Info |
|-----------|:--------:|:----:|:------:|:---:|:----:|
| Security | 0 | 0 | 4 | 12 | 6 |
| Code quality | 0 | 0 | 4 | 16 | 11 |
| Architecture | 0 | 0 | 0 | 9 | 9 |
| **Overall** | **0** | **0** | **8** | **37** | **26** |

**Posture at audit time:** Simulation-only; `broadcastAvailable: false`, `auditRequired: true`. No live fund-loss path.

### Themes (must close before broadcast)

1. Fail-closed gates that are advisory rather than enforcing  
2. Same-block / freshness provenance not consistently threaded  
3. Flash-exit correctness bug (interest accrual) making normal-case exit un-executable  

### Security — Medium findings

| ID | Finding | Location | Impact |
|----|---------|----------|--------|
| sec-loopexecutor-1 | **Stale off-chain `repayAmountDiem` + full-collateral withdraw** | `LoopExecutor.sol` repay path; `exitPlan.ts` | Morpho accrues interest every block; asset repay leaves residual shares → full collateral withdraw reverts → atomic exit unusable (fail-closed, no fund loss) |
| sec-flashproof-1 | **Decoded-event cross-check never runs in production** | `simulator.ts`, `loopSimulationClient.ts` | viem `simulateContract` returns no logs; exit evidence mismatch is pass-by-default |
| sec-flashproof-2 | **Exit simulation at `latest` while evidence pinned to planning block (TOCTOU)** | `exitPlan.ts`, `simulator.ts` | Sim can pass on stale minDiemOut / debt / liquidity |
| sec-flashproof-3 | **`feeInclusiveRepayCovered` not an enforcing gate** | `flashFeeProof.ts`, `simulator.ts` | Proof coverage advisory; single upstream guard is sole protection |

### Security — Selected Low / Info

- Inert on-chain `force` flag (ABI dead field)  
- No explicit Morpho `isAuthorized` check before repay/withdraw-on-behalf (relies on Morpho revert)  
- Net-APY / Morpho / baseApy reads not same-block pinned  
- Flash-loan/route same-block check skipped when route evidence absent  
- Deadline never validated off-chain as in-the-future  
- `interpolateEnv` silently drops missing env vars  
- RPC block number/timestamp default to 0  
- Telegram channel configured but not delivered  
- Incomplete event reconciliation (`minDiemOut`, owner, `wstDiemSold`)  
- Fee-tier / pool pairing not validated in projection-only fee path  
- ceilDiv formula drift risk off-chain vs on-chain  
- HF gate uses `>= 1.7` vs SPEC strict `>`  

### Code quality — Medium findings

| Finding | Impact |
|---------|--------|
| Telegram delivery unimplemented (SPEC-mandated) | CRITICAL alerts never reach Telegram |
| `loop simulate --live` (non-JSON) crashes on raw bigints | Headline safety tool fails on success path |
| Fork tests no-op without `BASE_RPC_URL` | CI green without deploy/liquidity/unwind proofs |
| Core guards untested (reentrancy, nonce-replay, deadline, minDiemOut under-delivery) | Fail-closed properties unverified |

### Architecture — Low themes

- Flash-fee / coverage / WAD math triplicated (drift risk)  
- Four parallel fail-closed gating mechanisms, no single chokepoint  
- Exit always sells 100% collateral; no partial unwind  
- `exit()` returns all-zero `LoopResult`; no post-state assertion  
- Watch daemon / TUI and auto-deleverager unimplemented  

### Strengths called out

Constructor pins Uniswap V3 canonical pool; strict fee equality + `otherFee == 0`; unconditional `minDiemOut` floor; EVM-atomic exit; broadcast hard-disabled.

---

## 2. Launch specs internal audit — 2026-06-11

**Full report:** [`~/wstdiem-internal-docs/audit/SPEC-LAUNCH-AUDIT-2026-06-11.md`](file:///Users/augstar/wstdiem-internal-docs/audit/SPEC-LAUNCH-AUDIT-2026-06-11.md)  
**Scope:** SPEC002 (launch), SPEC003 (points), SPEC004 (token).

### Findings (all fixed in-pass)

| ID | Sev | Finding | Fix |
|----|-----|---------|-----|
| LAUNCH-1 | Medium | Phase 1 exit wording implied points program must already have run | Renamed to advancement criteria; points-engine attribution as transition requirement |
| POINTS-1 | Medium | No default points formula shape | Added formula families + bounded multipliers |
| TOKEN-1 | Low | No default minimum observation window before token launch | Default ≥2 finalized epochs and 30 calendar days |
| GOV-1 | Low | Safety-limit changes not listed under governance caps | Explicit ban on oracle/liquidation/route/executor safety-limit changes outside caps |
| TOKEN-2 | Low | Operator staking vs sWSTD backstop confusion | Renamed to keeper/operator bonding, separate from sWSTD |

**Result:** No unresolved findings. Invariants rechecked (WSTD not required for core loop; points non-transferable; token gated on usage/revenue/risk/legal/audits; SPEC001 production gate remains closed).

---

## 3. Step 7 — Spec-stage audit cycle — 2026-06-12

**Record:** [`~/wstdiem-internal-docs/STEP-7-AUDIT-CYCLE.md`](file:///Users/augstar/wstdiem-internal-docs/STEP-7-AUDIT-CYCLE.md)  
**Scope:** SPEC005, THREAT-MODEL, PHASE-B-GUIDANCE, spikes, exit-only `LoopExecutor.sol`, SPEC001.  
**Method:** Codex architect ∥ Codex security → integrate → Claude adversarial verify → integrate.  
**Intent:** Substitute for ~$50–100k external pre-spec firm engagement.

### Tally (pre-integration)

| Pass | Critical | High | Medium | Extra |
|------|:--------:|:----:|:------:|-------|
| Codex architect | 3 | 5 | 5 | Would-not-sign-off |
| Codex security | 2 | 4 | 3 | I-66…I-72 proposed |
| Claude verification | 3 | 8 | 6 | Cross-doc inconsistencies after integrate |

### Integrated Critical fixes (F-series)

| ID | What changed |
|----|--------------|
| F-1 | Open-loop: user transfers wstDIEM only; flash DIEM for `vault.deposit`; no `initialDIEM` |
| F-2 | Digest includes `executionKind` + `mevWaiverBits` |
| F-3 | MEV modes: split `PRIVATE_BUILDER` from `SEQUENCER_DIRECT_FAILOPEN` (4-value enum) |
| F-4 | I-66 EIP-1271 preimage display attestation for high-risk policies |
| F-5 | I-71 `ExternalProtocolFingerprint` semantic drift detection |
| F-13 | **Topology 4 executors → 2** (`LoopExecutorV2` + `LoopForceExitExecutor`) |

### Integrated High fixes (selected)

| ID | What changed |
|----|--------------|
| F-6 | Event envelope G12: Started/Step/Completed + external logs by (txHash, block, logIndex) |
| F-7 | Indexer anchor authority + key rotation |
| F-8 | I-67 force-exit waiver minimality; no stored force-exit policies Phase 1; 24h deadline |
| F-9 | I-68 RPC quorum provider-family independence |
| F-10 | I-69 harvest-convergence cooling (block leverage-up after harvest) |
| F-11 | I-70 EvidenceSource[] canonical-set encoding |
| F-12 | Economic distance bounds on Open and Exit |

### Claude VF-series (Critical/High integration debt)

| ID | Sev | What closed |
|----|-----|-------------|
| VF-1 | C | §16 O27 enum 4-value vs 3-value contradiction |
| VF-2 | C | THREAT-MODEL still listed obsolete 4-executor topology |
| VF-3 | C | I-55 executionKind enum mismatch SPEC vs threat model |
| VF-4 | H | 17 missing canonical error codes in §5.5 |
| VF-5 | H | Post-matrix gates G-PM-1…6; I-66 digest-content-only |
| VF-6 | H | I-66…I-72 as defenders on attack chains; 72 invariants |
| VF-7 | H | Per-action post-matrix gate bullets on Open/Rebalance/Exit |

### Deferred Mediums (Phase A appendix, not Step-7 blockers)

NF-7 freshness-window consolidation · NF-8 OPERATOR_RECOVERY predicate · NF-9 Safe wallet allow-list · NF-11 fingerprint tolerance baselines · NF-12 transient storage layout · NF-13 SDK surface for new fields · NF-15 I-66 attestation field expansion.

---

## 4. Phase A interface appendix audit — 2026-06-12

**Artifacts:** `PHASE-A-INTERFACE-SHAPES.md`, `INTERFACE-APPENDIX-A.md` (in `~/wstdiem-internal-docs/`).

| Pass | Outcome |
|------|---------|
| Codex shapes | Full Solidity surface; 73-error canonical set; Solc 0.8.24 clean |
| Codex parameterization | Bound-parity matrix, evidence schedule, numeric defaults, NF-7…15 resolutions |
| Claude adversarial | **2 Critical + 5 High + 8 Medium** |

**Critical/High closed via VFA-1…VFA-7** (examples):

- Unified `sourceId` namespace `wstdiem.source.<label>`  
- Fixed `EVIDENCE_BUNDLE_TYPEHASH` self-reference + `evidenceSetId`  
- NF-7 windows ordered in seconds  
- NF-8 `forceExitBufferBps=0` Phase B fallback + proposed I-73  
- Cross-cutting A1 rows for executionKind / mevWaiverBits / EIP-1271 / throttle  
- `validateExternalConfig` reads registry not calldata  
- A5 ABI-boundary enum mapping table  

8 Mediums tracked as Phase B PR-1 review comments (not architectural blockers).

---

## 5. Round 2 — SPEC↔appendix drift + AutomationExec attacker — 2026-06-12

**Record:** continuation of `STEP-7-AUDIT-CYCLE.md`.

| Pass | Findings |
|------|----------|
| Codex drift sweep | 26 drifts (D-1…D-26): **2 Critical, 18 High, 6 Medium** |
| Codex AutomationExec attacker | AC-16…AC-25 + proposed I-73…I-82 |
| Claude verification | 30/36 VALID; 8 Tier 1+2 blockers |

### Highest-impact integrated fixes

| ID | Sev | Finding / fix |
|----|-----|---------------|
| R2F-1 (D-5) | C | `ActionEvidence` / `evidenceBundleHash` vs `evidenceSetId` digest parity |
| R2F-2 (D-17) | C | Missing TypeScript `Policy` interface (SDK would not compile) |
| R2F-3 (D-11) | C | Missing callback errors (`ReentrantCallback`, etc.) in canonical set |
| R2F-7 (AC-17) | C | **Permissionless AutomationExec scope restricted** — only REPAY_ONLY / DELEVERAGE_ONLY / FORCE_EXIT (one-shot); opaque `triggerConditionHash` made keeper the arbiter |
| R2F-4…R2F-6, R2F-8 | H | Registry merkle + marketParams in digest; remove `failureConditionHash`; SDK-only errors marked; `cancelNonce` for revoke path |

**Status after R2:** Phase B PR-1 unblocked; confidence on locked Phase A set ~92–95%.

---

## 6. Protocol v6 full implementation audit — 2026-06-17

**Scope:** AntFleet/wstdiem protocol monorepo (not the local tool-only checkout), commit ~`7522777`.  
**Method:** 31 finders + refutation panels + completeness critic; 124 raw → **118 confirmed**.  
**Durable report path (as recorded):** `~/wstdiem-protocol-v6-audit-2026-06-17.md` and `/tmp/wstdiem-protocol-audit/AUDIT-PROTOCOL-V6-2026-06-17.md` — **files not present on disk as of 2026-07-13**; summary below is from project memory + live code cross-check.

### Counts

| Severity | Confirmed |
|----------|:---------:|
| Critical | 1 |
| High | 19 |
| Medium | 36 |
| Low | 47 |
| Info | 15 |
| Dropped | 6 |

**Verdict at audit time:** **DO NOT seek external audit or launch.** Overall risk Critical.

### Launch-blocking Critical

| Finding | Detail |
|---------|--------|
| **Shares used as assets in position debt** | `LoopExecutorBase._readMorphoPosition` stored raw Morpho `borrowShares` as `debt` (no shares→assets conversion). Propagates into repay amount, flash size, and `_healthFactorWad`. After any interest accrues: EXIT / FORCE_EXIT / AutomationExec / health-recovery can revert → positions permanently un-unwindable. Correct conversion pattern exists in `LoopRiskOracleAdapter` (`borrowShares * totalBorrowAssets / totalBorrowShares`). |

**Live code check (2026-07-13):** `contracts/v2/LoopExecutorBase.sol` still assigns:

```solidity
debt = uint256(borrowShares);  // ~line 340
```

while `LoopRiskOracleAdapter.sol` correctly converts shares→assets. **This Critical remains open in current tree unless fixed on another branch.**

### High clusters (themes)

1. **Off-chain → on-chain trust boundary open**  
   - Anchor blindly notarizes unverified indexer data  
   - No block-hash / reorg cross-check  
   - Indexer `confirmationBlocks` default 2 vs spec 10  
   - Indexer never signed responses (SDK verifier unreachable) — *later partially addressed in launch readiness T1*  
   - ABI/topic0 desync silently drops events  

2. **§7.1 fail-closed degraded-mode matrix unenforced on-chain**  
   - `computeStateBitmap` had zero exec consumers  
   - EvidenceSource.status hashed but not asserted  
   - Force-exit `acknowledgedRisks` bits cosmetic  

3. **Deploy ships fail-open**  
   - `sourceFreshnessThreshold` + `requiredEvidenceSourceSet` never set  
   - Deploy verify checked wiring only  

4. **SDK/app fail-closed posture UI-only**  
   - Weakest on irreversible force-exit path  

### Completeness-critic extras (not fully adversarially verified at time)

- Oracle price decimal normalization (Chainlink 1e8 / Morpho 1e36 vs HF /1e18) — potentially Critical  
- SpenderCheck / allowedSpender dead on-chain enforcement  
- Admin-key registry takeover (plain Ownable; no 2-step/timelock on batchUpdate)  
- Revoke has no executor entry point  
- Large fraction of Playwright E2E action-path tests `fixme`/skip  

### Remediation plan (6-tier)

Recorded 2026-06-17 — **63 C/H/M** items planned:

| Tier | Focus | Count (approx) |
|------|--------|----------------|
| 0 | Root-of-trust: health math (F01+F02) + registry governance (F22) | 3 |
| 1 | On-chain safety semantics | 18 |
| 2 | Deploy fail-closed | 3 |
| 3 | Off-chain↔on-chain (anchor/indexer/sdk) | 24 |
| 4 | App fail-closed posture | 8 |
| 5 | Test & CI backfill | 7 |

Default decisions noted: Ownable2Step + timelock on critical mutators (or Safe+Timelock if size-constrained); wire spender allowlist; rebalance min-shares via signed-bound denomination.  
**Cross-tier tri-auditor** was required after merges (caught 6 new interaction defects after Tier-1 alone).

---

## 7. PR-level audits (selected)

Workflow: materialize **COMPLIANCE-REPORT** + **ADVERSARIAL-REPORT** + **FIX-LIST**, then audit-2 re-check.

| PR / cycle | Outcome |
|------------|---------|
| PR-11 | Codex+Codex+Claude fixes locked in `sdk/test/audit-fixes.test.ts` (e.g. A4-H1 high-risk classification without caller trust) |
| PR-16 | Two-server env audit validation; WIP orphan commit hygiene |
| PR-17 audit-2 | 3 informational: silent-skip operator trace; log-range cap; `maxQuoteAgeBlocks` SDK warn |
| PR-19 accuracy | 4 MAJOR + 4 MINOR all integrated (mevWaiverBits naming, MEV posture docs, anchor freshness API, G-PM-6 permission gates) |

---

## 8. External / production audit gate

### Declared policy

From protocol `SECURITY.md` and `docs/keeper/08-audit-gate.md`:

- **Phase 1 gate CLOSED** until external audit + deployment manifest review + governance + timelock.  
- When closed: Open blocked; leverage-up Rebalance blocked; deleverage / Exit / ForceExit / Revoke allowed.  
- Reclose triggers include executor code, EIP-712 auth structs, registry entries, risk oracle, error set, RPC/MEV policy, state bitmap, events, admin roles.  
- Bug bounty: **not established** (planned, likely Immunefi).  
- Public reports expected under repo `audit/` — **directory not populated with firm reports**.

### Tool vs protocol gates

| Surface | Gate doc | State |
|---------|----------|-------|
| Exit-only `LoopExecutor` (loop manager tool) | `wstdiem/docs/deployment/audit-gate.md` | **Closed** — no production broadcast |
| Protocol v2 (`LoopExecutorV2`, force-exit, registry, etc.) | `PROTOCOL.md` §5.4 / keeper `08-audit-gate.md` | **Closed** — Phase 1 |

### Launch readiness (2026-07-12)

`LAUNCH_READINESS.md` tracks Base Sepolia beta progress (mocks deployed, fingerprints timelocked). Explicit remaining blocker:

- [ ] **T10. External audit gate closed**

---

## 9. Cross-cutting findings that still matter

These recur across audits and remain relevant for any external review:

| Theme | First seen | Risk if unfixed |
|-------|------------|-----------------|
| Morpho **shares vs assets** debt accounting | Tool 2026-06-03 (repay); Protocol 2026-06-17 (Critical) | Unwind path bricks after interest |
| Same-block / freshness evidence | Tool audit | Stale sim pass → failed or unsafe broadcast |
| Fail-closed gates advisory vs enforcing | Tool + protocol | Silent pass on missing proofs / matrix bits |
| Force-exit / EIP-1271 blind-signing | Step 7 / R2 | Cheapest drain path for smart-wallet users |
| Off-chain indexer/anchor trust | Protocol v6 | Fake evidence notarized on-chain |
| External venue semantic drift | Step 7 I-71 | Registry hash green, economics wrong |
| Registry / admin governance | Protocol v6 | Single-tx config takeover |
| Decimal / price normalization | Completeness critic | Wrong HF → false liquidations or stuck positions |
| Test / CI skips (fork env, Playwright fixme) | Multiple | Green CI without load-bearing proofs |

---

## 10. Source index

| Artifact | Path |
|----------|------|
| Loop manager consolidated audit | `~/wstdiem-internal-docs/audit/AUDIT-2026-06-03.md` |
| Launch specs audit | `~/wstdiem-internal-docs/audit/SPEC-LAUNCH-AUDIT-2026-06-11.md` |
| Step 7 cycle (F/VF/R2/Phase A) | `~/wstdiem-internal-docs/STEP-7-AUDIT-CYCLE.md` |
| Threat model (post v1.2+) | `~/wstdiem-internal-docs/THREAT-MODEL.md` |
| Protocol security policy | `wstdiem-protocol/SECURITY.md` |
| Protocol public spec | `wstdiem-protocol/PROTOCOL.md` |
| Audit gate (keeper) | `wstdiem-protocol/docs/keeper/08-audit-gate.md` |
| Tool audit gate | `wstdiem/docs/deployment/audit-gate.md` |
| Launch readiness | `wstdiem-protocol/LAUNCH_READINESS.md` |
| Protocol v6 full report | *Missing on disk* — recover from backup/session if needed |
| This summary | `wstdiem/docs/WSTDIEM-PROTOCOL-AUDITS.md` |

---

## 11. Remediation progress (2026-07-13)

Implemented on branch `audit-remediation-trust-root` in `wstdiem-protocol`:

| Item | Status |
|------|--------|
| Critical F01 shares-to-assets debt | **Done** |
| F02 oracle price scale normalize | **Done** |
| F22 Ownable2Step | **Done** |
| F31 allowedSpender enforcement | **Done** (when rows registered) |
| §7.1 live state bitmap + ForceExit waivers | **Done** |
| Deploy `assertProductionReadiness` | **Done** |
| Indexer confirmations default 10 | **Done** |
| SDK `requireIndexerSignatures` | **Done** |
| `TrustRootAudit.t.sol` | **Done** (forge 227 + SDK 299 green) |

## 12. Recommended next steps (from audit history)

1. Critical debt conversion — done 2026-07-13.
2. Complete remaining tiered remediation and re-run cross-tier tri-auditor.
3. Commission external firm audit; publish under `audit/`.
4. Do not clear production audit gate without external report + frozen commit + evidence.
5. Restore missing 2026-06-17 full report from backup if needed for full tracking.

---

*This document is a research compilation of existing internal audits. It is not a substitute for an independent third-party security assessment.*
