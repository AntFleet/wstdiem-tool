# Resource ladder

Canonical terms for DIEM, Venice credit, wstDIEM, loop economics, and bounded execution. Operator docs, CLI labels, and JSON should use these words as written.

This CLI is decision-support only. `loop ledger`, `loop sizing`, and `loop capacity` do not broadcast, do not protect positions, and are not investment advice.

## The ladder

1. **DIEM**
   Raw Venice compute token on Base. When staked, it grants daily Venice API credit.

2. **Venice credit**
   Consumable API capacity from staked DIEM. It is not token yield unless the credit is actually consumed, sold, routed, or otherwise monetized. Unused credit remains `$0` token yield.

3. **wstDIEM**
   Rebase-free vault/share token over DIEM-backed assets. Wallet balance does not automatically increase. Value changes through NAV / `convertToAssets` (the exchange rate), not through rebasing.

4. **`DIEMCredited`**
   Tier 1, chain-proven event showing DIEM actually credited/staked into the vault and raising holder NAV. This is the `loop ledger` utilization numerator.

5. **`SettlementReceived` / `YieldRouted`**
   Tier 2 context. On-chain-real amounts, but not full proof that demand is external or organic. Never the utilization numerator, and never labeled inference demand.

6. **External demand vs protocol-seeded flow**
   Tier 3 limitation. The chain cannot prove whether settled USDC reflects external demand or protocol self-seeding. State this plainly.

7. **Loop spread**
   Realized or modeled vault/NAV yield minus Morpho borrow cost and execution costs. It is not guaranteed, not advice, and not a forward yield promise.

8. **Loop position**
   User-owned collateral/debt state with liquidation risk. This tool holds no position and takes no protective action.

9. **Keeper**
   Operator that proposes or executes only within signed bounds. A keeper cannot change action type, widen bounds, bypass gates, or silently degrade MEV mode. Keepers turn the crank inside the signed envelope; they do not run buybacks, burns, arena mechanics, or reflexive tokenomics. If live state is outside the envelope, execution fails closed and the position remains unchanged.

10. **Sizing candidate / capacity candidate**
    Decision-support under model assumptions. Not permission to deploy, not automated protection, not investment advice. A `candidate` with `authoritative: false` is unverified.

## `loop ledger` mapping

**Venice credit utilization** means estimated Venice credit capacity *if spent* versus Tier 1 credited evidence:

| Piece | Meaning |
|---|---|
| Denominator | Vault-staked DIEM, as estimated daily Venice credit capacity. `$1/day per DIEM` only if that credit is spent; `$0` token yield if unused. Unreadable denominator → `n/a`, never a fabricated ratio. |
| Numerator | Window `DIEMCredited` as a daily rate. **Tier 1.** |
| Tier 2 context | `SettlementReceived` USDC and `YieldRouted` DIEM. On-chain-real, not external-demand proof. |
| Quiet window | Zero recent `DIEMCredited` is **not** zero demand. `routeYield` / keeper cadence is lumpy; unrouted USDC or missing cadence makes demand `ambiguous`. |

JSON always includes `decisionSupportOnly`, `notAdvice`, `notAYieldPromise`, trust labels, and liveness `{ status, ageSeconds, reason }`.

## What this is not

- wstDIEM is not a rebasing Lido / wstETH wrapper.
- Venice credit is not token yield while it sits unspent.
- A quiet `DIEMCredited` window is not “zero demand.”
- `SettlementReceived` / `YieldRouted` do not prove organic external demand.
- `loop ledger` / `loop sizing` / `loop capacity` cannot broadcast or protect a position.

## Known residuals (documented, not keeper discretion)

- Phase 1 stored automation policies persist `policyHash` but numeric `minRepay` / `maxCollateralSold` / `maxDebtIncrease` are zero. Deleverage-class AutomationExec cannot sell collateral until a future policy-body ABI (audit-gate reclose). That fails closed; it is not a keeper choice.
- SDK G-PM-5 / keeper MEV: a `PRIVATE_BUILDER` digest must not silently degrade onto sequencer-direct (`MevModeMismatch` / `KeeperBuilderOutage`, not a waiver-bit shortcut).

## See also

- [Operator runbook](./operator-runbook.md) — on-ramp, including `loop ledger`
- [Monitoring](./monitoring.md) — sampling cadence and ledger liveness
- [Loop sizing](./loop-sizing.md) — `candidate` / `marginal` / `blocked`
- Protocol user ladder: `wstdiem-protocol/docs/user/00-resource-ladder.md`
