#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { deliverConfiguredAlerts } from "../alerts/deliver.js";
import { evaluateAlerts } from "../alerts/evaluate.js";
import { makeEmptySnapshot } from "../metrics/math.js";
import { Storage } from "../storage/sqlite.js";
import { createViemLoopSimulationClient } from "../contracts/loopSimulationClient.js";
import { simulateMorphoAuthorization } from "../loop/authorization.js";
import { buildLiveLoopExitPlan } from "../loop/exitPlan.js";
import { buildLoopReadiness } from "../loop/readiness.js";
import type { LoopReadinessResult } from "../loop/readiness.js";
import { buildConfiguredLoopSafetyEvidence } from "../loop/safetyEvidence.js";
import { simulateLoopExecutorCall } from "../loop/simulator.js";
import { buildLoopBrief, fingerprintFromTemplate } from "../loop/brief.js";
import {
  CapacitySearchError,
  findLoopCapacity,
  type CapacityInputMode,
  type ExitSlippageQuoter,
} from "../loop/capacity.js";
import { buildLoopSizingReport, type LoopSizingScenario } from "../loop/sizing.js";
import {
  buildLoopSizingScenarios,
  parseDecimalToBps,
  type LoopSizingGridOptions,
} from "../loop/sizingScenarios.js";
import {
  assertFromChainCompatibleOptions,
  buildFromChainSizingReport,
  computeExitSlippageInjection,
  loadVaultApyWindow,
  seedFromChain,
  type FromChainExplicitFlags,
  type FromChainSeedClient,
} from "../loop/fromChainSeed.js";
import { formatWad, parseDecimalToUnits } from "../metrics/math.js";
import { evaluateReadinessAlerts } from "../monitor/readinessAlerts.js";
import type { AppConfig, Severity } from "../types/domain.js";
import { CliError, toCliError } from "./errors.js";
import {
  assertBroadcastNotAllowed,
  buildLoopExecutorParamsForCommand,
  projectLoopCommand,
} from "./loop.js";
import {
  jsonEnvelope,
  printJson,
  renderLoopBrief,
  renderLoopCapacityTable,
  renderLoopReadinessTable,
  renderLoopSizingTable,
  renderMonitorDashboard,
  renderStatusTable,
  stringifyJson,
} from "./output.js";
import { parseAddress, parseStrictFloat, parseStrictInteger } from "./parse.js";
import { buildStatus, runWatchOnce } from "./status.js";
import { classifyMonitoringOutcome, isMonitorAssessed } from "./exitCode.js";

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

const AUDIT_GATE_BLOCKER = "broadcast disabled pending production executor audit/review";

function assertStrictLoopReadinessEvidence(result: LoopReadinessResult): void {
  const auditGate = result.checks.find((check) => check.key === "audit-gate");
  const nonAuditIssues = result.checks.filter(
    (check) => check.key !== "audit-gate" && check.status !== "pass",
  );
  const unexpectedBlockers = result.blockers.filter((blocker) => blocker !== AUDIT_GATE_BLOCKER);

  if (
    result.broadcastAvailable !== false ||
    result.auditRequired !== true ||
    auditGate?.status !== "fail" ||
    nonAuditIssues.length > 0 ||
    unexpectedBlockers.length > 0
  ) {
    const details = [
      ...nonAuditIssues.map((check) => `${check.key}:${check.status}`),
      ...unexpectedBlockers.map((blocker) => `blocker:${blocker}`),
      auditGate?.status === "fail" ? undefined : "audit-gate:not-fail",
      result.broadcastAvailable === false ? undefined : "broadcastAvailable:not-false",
      result.auditRequired === true ? undefined : "auditRequired:not-true",
    ].filter((entry): entry is string => entry !== undefined);

    throw new CliError(
      "READINESS_EVIDENCE_BLOCKED",
      details.length === 0
        ? "strict readiness evidence failed"
        : `strict readiness evidence failed: ${details.join(", ")}`,
      undefined,
      result,
    );
  }
}

function configFor(command: Command): AppConfig {
  const opts = command.optsWithGlobals<GlobalOptions>();
  return loadConfig({ configPath: opts.config });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAction<T>(
  command: Command,
  commandName: string,
  action: (config: AppConfig) => Promise<T> | T,
): Promise<void> {
  const opts = command.optsWithGlobals<GlobalOptions>();
  let config: AppConfig | undefined;
  try {
    config = configFor(command);
    const data = await action(config);
    if (opts.json) {
      printJson(jsonEnvelope(config, commandName, data));
    } else if (typeof data === "string") {
      console.log(data);
    } else {
      console.log(stringifyJson(data));
    }
  } catch (error) {
    const cliError = toCliError(error);
    const chainId = config?.chainId ?? 8453;
    if (opts.json) {
      printJson({
        ok: false,
        command: commandName,
        chainId,
        data: cliError.data,
        error: {
          code: cliError.code,
          message: cliError.message,
          cause: cliError.causeText,
        },
      });
      process.exitCode = 1;
      return;
    }
    console.error(`${cliError.code}: ${cliError.message}`);
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name("wstdiem-loop-manager")
  .description("Operator CLI for wstDIEM loop monitoring and safety-first simulation")
  .version("0.1.0")
  .option("--config <path>", "config YAML path", "config.yaml")
  .option("--json", "emit JSON envelope");

program
  .command("status")
  .description("One-shot snapshot")
  .option("--owner <address>", "position owner override")
  .action(async function (this: Command) {
    await runAction(this, "status", async (config) => {
      const owner = this.opts<{ owner?: string }>().owner;
      if (owner !== undefined) {
        config = { ...config, position: { owner: parseAddress(owner, "--owner") } };
      }
      const result = await buildStatus(config);
      // SPEC004 §3/§4: classify on the fully-built result, then set process.exitCode as
      // the last step (it cannot throw, so runAction's catch→1 can never be overridden and
      // nominal(0) can never overwrite a tool-error). assessed = liveAssessed, so a partial
      // read leaves it false → indeterminate(20), never a false nominal(0).
      const classification = classifyMonitoringOutcome({
        assessed: result.snapshot.validity.liveAssessed,
        alerts: result.alerts,
      });
      process.exitCode = classification.exitCode;
      const structured = { ...result, ...classification };
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return structured;
      }
      return renderStatusTable(result.snapshot, result.readiness);
    });
  });

program
  .command("watch")
  .description("Persistent daemon and dashboard")
  .option("--once", "run one polling iteration and exit")
  .option("--no-tui", "disable TUI rendering")
  .action(async function (this: Command) {
    await runAction(this, "watch", async (config) => {
      const opts = this.opts<{ once?: boolean }>();
      if (!opts.once) {
        throw new CliError(
          "NOT_IMPLEMENTED",
          "Persistent TUI is not implemented in this slice; use watch --once",
        );
      }
      const result = await runWatchOnce(config);
      // SPEC004 §3/§4: same read-completed gate + severity ladder as `status` (watch --once
      // returns the identical StatusResult). liveAssessed is inherited via buildStatus.
      const classification = classifyMonitoringOutcome({
        assessed: result.snapshot.validity.liveAssessed,
        alerts: result.alerts,
      });
      process.exitCode = classification.exitCode;
      const structured = { ...result, ...classification };
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return structured;
      }
      return renderStatusTable(result.snapshot, result.readiness);
    });
  });

program
  .command("monitor")
  .description("Operator dashboard for live Curve, Morpho, executor, and owner readiness")
  .option("--owner <address>", "position owner override")
  .option("--loop-executor <address>", "loopExecutor override for live monitoring")
  .option("--alert", "deliver monitor alerts to configured stderr/webhook/Telegram channels", false)
  .action(async function (this: Command) {
    await runAction(this, "monitor", async (config) => {
      const opts = this.opts<{ owner?: string; loopExecutor?: string; alert?: boolean }>();
      const owner =
        opts.owner === undefined ? config.position.owner : parseAddress(opts.owner, "--owner");
      if (opts.loopExecutor !== undefined) {
        config = {
          ...config,
          contracts: {
            ...config.contracts,
            loopExecutor: parseAddress(opts.loopExecutor, "--loop-executor"),
          },
        };
      }

      let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>> | undefined;
      try {
        client = (await createViemLoopSimulationClient(config)) ?? undefined;
      } catch {
        client = undefined;
      }
      // SPEC005 §7 — `monitor` is the danger command: it (and only it) reads live
      // LLTV + oracle for the liquidation readout. `loop readiness` leaves the flag
      // off, so --strict-evidence is untouched.
      const readiness = await buildLoopReadiness({
        config,
        owner,
        client,
        includeLiquidation: true,
      });
      const alerts = evaluateReadinessAlerts(readiness, config.thresholds);
      const delivered = opts.alert
        ? await deliverConfiguredAlerts(
            config,
            alerts,
            readiness.blockNumber ?? 0n,
            Math.floor(Date.now() / 1000),
          )
        : [];
      // SPEC004 §3/§4: monitor's read completed ⇔ a block was read AND no rpc-* check
      // failed. A failed rpc-* (or undefined blockNumber) → indeterminate(20), gating
      // before alert severity (so blockNumber===undefined + live_rpc_unavailable CRITICAL
      // is 20, not 30). Alert levels alone drive warn/critical — executor_missing/
      // owner_missing are WARN(10), the closed audit gate is never an alert.
      const classification = classifyMonitoringOutcome({
        assessed: isMonitorAssessed(readiness),
        alerts,
      });
      process.exitCode = classification.exitCode;
      const result = { readiness, alerts, delivered, ...classification };
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return result;
      }
      return renderMonitorDashboard(readiness, alerts, delivered);
    });
  });

const loop = program.command("loop").description("Loop position commands");

loop
  .command("sizing")
  .description(
    "Offline loop sizing simulator for Curve, Morpho, APY, slippage, and unwind scenarios",
  )
  .option("--json", "emit JSON envelope")
  .option("--preset <preset>", "baseline|current-zero|liquidity-sweep", "baseline")
  .option("--initial-diem <amounts>", "comma-separated initial DIEM equity amounts")
  .option("--initial-wstdiem <amounts>", "comma-separated initial wstDIEM collateral amounts")
  .option("--wstdiem-nav <amount>", "DIEM value of 1 wstDIEM when --initial-wstdiem is used", "1")
  .option("--target-leverage <values>", "comma-separated leverage targets", "1.5,2,3")
  .option(
    "--curve-depth-diem <amounts>",
    "comma-separated total (two-sided) Curve depth in DIEM; split into balanced legs (mutually exclusive with --curve-*-leg)",
  )
  .option(
    "--curve-diem-leg <amounts>",
    "comma-separated Curve DIEM-side leg depths in DIEM (the exit draws this leg)",
  )
  .option(
    "--curve-wstdiem-leg <amounts>",
    "comma-separated Curve wstDIEM-side leg depths in DIEM-equivalent (the entry draws this leg)",
  )
  .option("--morpho-supply-diem <amounts>", "comma-separated Morpho supply assumptions in DIEM")
  .option(
    "--morpho-existing-borrow-diem <amount>",
    "existing Morpho borrow to reserve from usable supply",
  )
  .option("--vault-apy-bps <bps>", "comma-separated vault APY assumptions in bps", "1500")
  .option(
    "--borrow-rate-model <model>",
    "borrow-cost model: adaptive-curve (utilization-aware, default) or flat",
    "adaptive-curve",
  )
  .option(
    "--rate-at-target-apy-bps <bps>",
    "adaptive-curve: AdaptiveCurveIrm rate-at-target (90% util) APY in bps. Default 400 is the conservative Morpho-genesis value (deliberately pessimistic — a higher assumed borrow rate blocks more, never less); pass the live value (--rate-at-target-apy-bps 217) or --from-chain for realistic sizing",
    "400",
  )
  .option(
    "--borrow-apy-bps <bps>",
    "flat model only: comma-separated Morpho borrow APY assumptions in bps",
    "800",
  )
  .option("--curve-fee-bps <bps>", "Curve fee assumption in bps")
  .option("--slippage-bps <bps>", "maximum acceptable simulated entry/exit slippage bps")
  .option("--flash-fee-bps <bps>", "flash fee assumption in bps")
  .option(
    "--max-curve-position-share-bps <bps>",
    "maximum position/depth share before Curve blocks",
  )
  .option("--max-morpho-utilization-bps <bps>", "maximum Morpho utilization available to this loop")
  .option("--min-health-factor <value>", "minimum post-loop health factor")
  .option("--min-net-apy-bps <bps>", "minimum acceptable net APY in bps")
  .option("--holding-days <days>", "holding period for annualizing one-time costs")
  .option(
    "--gas-cost-diem <amount>",
    "one-time gas cost in DIEM folded into net APY (default 0; gas is otherwise unmodeled and a warning rides the verdict)",
  )
  .option(
    "--from-chain",
    "seed rateAtTarget, Morpho supply, and existing borrow from live Base reads",
    false,
  )
  .option("--planning-block <n>", "pin the on-chain seed reads to a specific block (default latest)")
  .action(async function (this: Command) {
    await runAction(this, "loop sizing", async (config) => {
      const options = this.opts<
        LoopSizingGridOptions & { fromChain?: boolean; planningBlock?: string }
      >();
      const wantsJson = this.optsWithGlobals<GlobalOptions>().json;

      if (!options.fromChain) {
        let scenarios;
        try {
          scenarios = buildLoopSizingScenarios(config, options);
        } catch (error) {
          throw new CliError(
            "INVALID_INPUT",
            error instanceof Error ? error.message : String(error),
          );
        }
        const report = buildLoopSizingReport(scenarios);
        return wantsJson ? report : renderLoopSizingTable(report);
      }

      // Static conflict guards run BEFORE any RPC client is constructed, so a
      // flat-model/current-zero conflict errors without touching the network.
      assertFromChainCompatibleOptions(options);

      const planningBlock =
        options.planningBlock === undefined
          ? undefined
          : BigInt(parseStrictInteger(options.planningBlock, "--planning-block"));
      let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>>;
      try {
        client = await createViemLoopSimulationClient(config);
      } catch (error) {
        throw new CliError(
          "FROM_CHAIN_SEED_BLOCKED",
          `RPC unavailable for --from-chain seeding: ${errorMessage(error)}`,
        );
      }
      if (client === null) {
        throw new CliError(
          "FROM_CHAIN_SEED_BLOCKED",
          "at least one RPC URL must be configured for --from-chain seeding",
        );
      }
      // Open the SQLite window seam for vault-APY seeding (SPEC003 §4.3). A fresh checkout has an
      // empty DB → `not-seeded` → demote (correct first-run behavior). Mirror status.ts open/close.
      const store = new Storage(config.storage.sqlitePath);
      let report;
      try {
        report = await buildFromChainSizingReport({
          config,
          client,
          options,
          store,
          explicitFlags: {
            rateAtTargetApyBps: this.getOptionValueSource("rateAtTargetApyBps") === "cli",
            morphoSupplyDiem: this.getOptionValueSource("morphoSupplyDiem") === "cli",
            morphoExistingBorrowDiem: this.getOptionValueSource("morphoExistingBorrowDiem") === "cli",
            curveDepthDiem: this.getOptionValueSource("curveDepthDiem") === "cli",
            curveDiemLeg: this.getOptionValueSource("curveDiemLeg") === "cli",
            curveWstdiemLeg: this.getOptionValueSource("curveWstdiemLeg") === "cli",
            vaultApyBps: this.getOptionValueSource("vaultApyBps") === "cli",
          },
          planningBlock,
        });
      } finally {
        store.close();
      }
      return wantsJson ? report : renderLoopSizingTable(report);
    });
  });

loop
  .command("readiness")
  .description("Read live Curve, Morpho, executor, and owner exit readiness")
  .option("--owner <address>", "position owner override")
  .option("--loop-executor <address>", "loopExecutor override for live readiness evidence")
  .option(
    "--strict-evidence",
    "exit non-zero unless all live evidence checks pass except the closed audit gate",
    false,
  )
  .action(async function (this: Command) {
    await runAction(this, "loop readiness", async (config) => {
      const opts = this.opts<{ owner?: string; loopExecutor?: string; strictEvidence?: boolean }>();
      const ownerOption = opts.owner;
      const owner =
        ownerOption === undefined ? config.position.owner : parseAddress(ownerOption, "--owner");
      if (opts.loopExecutor !== undefined) {
        config = {
          ...config,
          contracts: {
            ...config.contracts,
            loopExecutor: parseAddress(opts.loopExecutor, "--loop-executor"),
          },
        };
      }
      let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>> | undefined;
      try {
        client = (await createViemLoopSimulationClient(config)) ?? undefined;
      } catch {
        client = undefined;
      }
      const result = await buildLoopReadiness({ config, owner, client });
      if (opts.strictEvidence) {
        assertStrictLoopReadinessEvidence(result);
      }
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return result;
      }
      return renderLoopReadinessTable(result);
    });
  });

function addLoopAction(name: "open" | "rebalance" | "exit"): Command {
  const cmd = loop.command(name);
  if (name !== "exit") {
    cmd.requiredOption("--target-leverage <number>", "target leverage");
  }
  if (name === "open") {
    cmd.requiredOption("--initial-diem <amount>", "initial DIEM amount");
  }
  cmd
    .option("--slippage-bps <bps>", "slippage tolerance in bps")
    .option("--dry-run", "simulate only", false)
    .option("--owner <address>", "owner override")
    .option("--from <address>", "transaction sender/operator override");
  if (name === "exit") {
    cmd.option("--force", "skip slippage guard only; simulation still mandatory", false);
  }
  return cmd.action(async function (this: Command) {
    await runAction(this, `loop ${name}`, (config) => {
      const opts = this.opts<{
        targetLeverage?: string;
        initialDiem?: string;
        slippageBps?: string;
        dryRun?: boolean;
        owner?: string;
        from?: string;
        force?: boolean;
      }>();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const projection = projectLoopCommand(config, {
        action: name,
        targetLeverage:
          opts.targetLeverage === undefined
            ? undefined
            : parseStrictFloat(opts.targetLeverage, "--target-leverage"),
        initialDiem: opts.initialDiem,
        slippageBps:
          opts.slippageBps === undefined
            ? undefined
            : parseStrictInteger(opts.slippageBps, "--slippage-bps"),
        dryRun: opts.dryRun,
        owner: opts.owner === undefined ? undefined : parseAddress(opts.owner, "--owner"),
        from: opts.from === undefined ? undefined : parseAddress(opts.from, "--from"),
        force: opts.force,
        nowSeconds,
      });
      if (!opts.dryRun) {
        assertBroadcastNotAllowed(projection);
      }
      return projection;
    });
  });
}

addLoopAction("open");
addLoopAction("rebalance");
addLoopAction("exit");

/** Shared sizing seed/fee/gate flags for capacity + brief (mirrors `loop sizing`). */
function addSizingSeedFlags(cmd: Command): Command {
  return cmd
    .option("--preset <preset>", "baseline|current-zero|liquidity-sweep", "baseline")
    .option("--initial-diem <amounts>", "placeholder equity (capacity sweeps this dim)")
    .option("--initial-wstdiem <amounts>", "comma-separated initial wstDIEM collateral amounts")
    .option("--wstdiem-nav <amount>", "DIEM value of 1 wstDIEM when --initial-wstdiem is used", "1")
    .option(
      "--curve-depth-diem <amounts>",
      "total Curve depth in DIEM; split into balanced legs (mutually exclusive with --curve-*-leg)",
    )
    .option(
      "--curve-diem-leg <amounts>",
      "Curve DIEM-side leg depth in DIEM (the exit draws this leg)",
    )
    .option(
      "--curve-wstdiem-leg <amounts>",
      "Curve wstDIEM-side leg depth in DIEM-equivalent (the entry draws this leg)",
    )
    .option("--morpho-supply-diem <amounts>", "Morpho supply assumption in DIEM")
    .option(
      "--morpho-existing-borrow-diem <amount>",
      "existing Morpho borrow to reserve from usable supply",
    )
    .option("--vault-apy-bps <bps>", "vault APY assumption in bps")
    .option(
      "--borrow-rate-model <model>",
      "borrow-cost model: adaptive-curve (default) or flat",
      "adaptive-curve",
    )
    .option(
      "--rate-at-target-apy-bps <bps>",
      "adaptive-curve rate-at-target APY in bps",
    )
    .option("--borrow-apy-bps <bps>", "flat model only: Morpho borrow APY in bps")
    .option("--curve-fee-bps <bps>", "Curve fee assumption in bps")
    .option("--slippage-bps <bps>", "maximum acceptable simulated entry/exit slippage bps")
    .option("--flash-fee-bps <bps>", "flash fee assumption in bps")
    .option(
      "--max-curve-position-share-bps <bps>",
      "maximum position/depth share before Curve blocks",
    )
    .option("--max-morpho-utilization-bps <bps>", "maximum Morpho utilization available to this loop")
    .option("--min-health-factor <value>", "minimum post-loop health factor")
    .option("--min-net-apy-bps <bps>", "minimum acceptable net APY in bps")
    .option("--holding-days <days>", "holding period for annualizing one-time costs")
    .option(
      "--gas-cost-diem <amount>",
      "one-time gas cost in DIEM folded into net APY (default 0)",
    )
    .option("--from-chain", "seed market inputs from live Base reads", false)
    .option("--planning-block <n>", "pin on-chain seed reads to a specific block (default latest)")
    .option(
      "--allow-offline-defaults",
      "escape hatch: allow capacity/brief without live seed or explicit market flags (non-authoritative, not persistable)",
      false,
    );
}

function hasExplicitMarketInputs(options: LoopSizingGridOptions): boolean {
  const hasCurve =
    options.curveDepthDiem !== undefined ||
    (options.curveDiemLeg !== undefined && options.curveWstdiemLeg !== undefined);
  return hasCurve && options.morphoSupplyDiem !== undefined;
}

function resolveCapacityInputMode(options: {
  fromChain?: boolean;
  allowOfflineDefaults?: boolean;
} & LoopSizingGridOptions): CapacityInputMode {
  if (options.fromChain) {
    return "from-chain";
  }
  if (hasExplicitMarketInputs(options)) {
    return "explicit-flags";
  }
  if (options.allowOfflineDefaults) {
    return "offline-defaults";
  }
  throw new CliError(
    "OFFLINE_CAPACITY_REFUSED",
    "capacity/brief refuse offline fantasy numbers: pass --from-chain, or explicit --curve-depth-diem (or both --curve-diem-leg and --curve-wstdiem-leg) plus --morpho-supply-diem, or --allow-offline-defaults",
  );
}

function seedAmountGrid(value: bigint): string {
  return formatWad(value, 18);
}

function buildSingleTemplate(
  config: AppConfig,
  options: LoopSizingGridOptions,
  leverage: string,
  inputMode: CapacityInputMode,
): LoopSizingScenario {
  const grid: LoopSizingGridOptions = {
    ...options,
    initialDiem: "1",
    targetLeverage: leverage,
  };
  // Offline defaults: pin multi-value sizing defaults to single deep points so the template is unique.
  if (inputMode === "offline-defaults") {
    if (grid.curveDepthDiem === undefined && grid.curveDiemLeg === undefined) {
      grid.curveDepthDiem = "10000";
    }
    if (grid.morphoSupplyDiem === undefined) {
      grid.morphoSupplyDiem = "10000";
    }
    if (grid.vaultApyBps === undefined) {
      grid.vaultApyBps = "1500";
    }
    if (grid.rateAtTargetApyBps === undefined) {
      grid.rateAtTargetApyBps = "400";
    }
  }
  let scenarios: LoopSizingScenario[];
  try {
    scenarios = buildLoopSizingScenarios(config, grid);
  } catch (error) {
    throw new CliError(
      "INVALID_INPUT",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (scenarios.length !== 1) {
    throw new CliError(
      "INVALID_INPUT",
      "capacity/brief require single-valued market inputs (no comma grids on curve/morpho/vault/borrow dims)",
    );
  }
  return scenarios[0];
}

function explicitFlagsFromCommand(command: Command): FromChainExplicitFlags {
  return {
    rateAtTargetApyBps: command.getOptionValueSource("rateAtTargetApyBps") === "cli",
    morphoSupplyDiem: command.getOptionValueSource("morphoSupplyDiem") === "cli",
    morphoExistingBorrowDiem: command.getOptionValueSource("morphoExistingBorrowDiem") === "cli",
    curveDepthDiem: command.getOptionValueSource("curveDepthDiem") === "cli",
    curveDiemLeg: command.getOptionValueSource("curveDiemLeg") === "cli",
    curveWstdiemLeg: command.getOptionValueSource("curveWstdiemLeg") === "cli",
    vaultApyBps: command.getOptionValueSource("vaultApyBps") === "cli",
  };
}

async function prepareFromChainCapacityTemplate(input: {
  config: AppConfig;
  client: FromChainSeedClient;
  options: LoopSizingGridOptions;
  explicitFlags: FromChainExplicitFlags;
  leverage: string;
  planningBlock?: bigint;
  store?: import("../loop/fromChainSeed.js").VaultApyWindowStore;
}): Promise<{
  template: LoopSizingScenario;
  blockNumber: bigint;
  seedProvenance: import("../loop/sizing.js").SeedProvenance;
  authoritative: boolean;
  warnings: string[];
  seedCurve: boolean;
  vaultApySource?: "measured-7d" | "not-seeded";
}> {
  const { config, client, options, explicitFlags, leverage, planningBlock, store } = input;
  assertFromChainCompatibleOptions(options);

  const anyExplicitCurveFlag = Boolean(
    explicitFlags.curveDepthDiem || explicitFlags.curveDiemLeg || explicitFlags.curveWstdiemLeg,
  );
  const curveSweptByPreset = options.preset === "liquidity-sweep";
  const seedCurve = !anyExplicitCurveFlag && !curveSweptByPreset;

  const { seeds, provenance } = await seedFromChain({
    config,
    client,
    planningBlock,
    seedCurve,
  });

  const gridOptions: LoopSizingGridOptions = { ...options };
  const seededFields = { ...provenance.seededFields };

  if (explicitFlags.rateAtTargetApyBps) {
    seededFields.rateAtTargetApyBps = "flag";
  } else {
    gridOptions.rateAtTargetApyBps = String(seeds.rateAtTargetApyBps);
  }
  if (explicitFlags.morphoSupplyDiem) {
    seededFields.morphoSupplyDiem = "flag";
  } else {
    gridOptions.morphoSupplyDiem = seedAmountGrid(seeds.morphoSupplyDiem);
  }
  if (explicitFlags.morphoExistingBorrowDiem) {
    seededFields.morphoExistingBorrowDiem = "flag";
  } else {
    gridOptions.morphoExistingBorrowDiem = seedAmountGrid(seeds.morphoExistingBorrowDiem);
  }
  if (
    seedCurve &&
    seeds.curveDiemLegDiem !== undefined &&
    seeds.curveWstDiemLegInDiem !== undefined
  ) {
    delete gridOptions.curveDepthDiem;
    gridOptions.curveDiemLeg = seedAmountGrid(seeds.curveDiemLegDiem);
    gridOptions.curveWstdiemLeg = seedAmountGrid(seeds.curveWstDiemLegInDiem);
    seededFields.curveDepthDiem = "chain";
  } else if (anyExplicitCurveFlag) {
    seededFields.curveDepthDiem = "flag";
  }

  let vaultApySource: "measured-7d" | "not-seeded" | undefined;
  let vaultAuthoritative = true;
  const vaultWarnings: string[] = [];
  if (explicitFlags.vaultApyBps) {
    seededFields.vaultApyBps = "flag";
    vaultApySource = "not-seeded";
    vaultAuthoritative = false;
    vaultWarnings.push(
      "vault APY is operator-supplied (--vault-apy-bps), not chain-measured — verdict is not authoritative",
    );
  } else if (store !== undefined) {
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const vaultApy = await loadVaultApyWindow({ config, client, store, nowSeconds });
      if (vaultApy.source === "measured-7d") {
        gridOptions.vaultApyBps = String(vaultApy.vaultApyBps);
        seededFields.vaultApyBps = "chain";
        vaultApySource = "measured-7d";
      } else {
        seededFields.vaultApyBps = "default";
        vaultApySource = "not-seeded";
        vaultAuthoritative = false;
        vaultWarnings.push(
          `vault APY not seeded (${vaultApy.reason}) — verdict is not authoritative`,
        );
      }
    } catch (error) {
      seededFields.vaultApyBps = "default";
      vaultApySource = "not-seeded";
      vaultAuthoritative = false;
      vaultWarnings.push(
        `vault APY not seeded (${errorMessage(error)}) — verdict is not authoritative`,
      );
    }
  }

  const template = buildSingleTemplate(config, gridOptions, leverage, "from-chain");
  const authoritative = provenance.authoritative && vaultAuthoritative;
  const warnings = [...provenance.warnings, ...vaultWarnings];
  return {
    template,
    blockNumber: provenance.blockNumber,
    seedProvenance: {
      ...provenance,
      seededFields,
      authoritative,
      warnings,
      vaultApySource,
    },
    authoritative,
    warnings,
    seedCurve,
    vaultApySource,
  };
}

function makeExitSlippageQuoter(
  config: AppConfig,
  client: FromChainSeedClient,
): ExitSlippageQuoter {
  return async (positionCollateralDiem, maxSlippageBps, blockNumber) => {
    try {
      const injection = await computeExitSlippageInjection({
        config,
        client,
        positionCollateralDiem,
        slippageBps: maxSlippageBps,
        blockNumber,
      });
      if (injection.exitSlippageBps !== undefined) {
        return { bps: injection.exitSlippageBps };
      }
      return { demote: injection.readiness ?? "no quote produced" };
    } catch (error) {
      if (error instanceof CliError) {
        return { hardFail: error.message };
      }
      return {
        hardFail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

addSizingSeedFlags(
  loop
    .command("capacity")
    .description(
      "Gate-bound absorption (last-candidate): largest equity clearing sizing gates at a fixed leverage",
    )
    .option("--json", "emit JSON envelope")
    .option(
      "--target-leverage <value>",
      // Default 1.5× (not 2×): under minPostLoopHealthFactor 1.7, structural HF at 2× is ~1.72
      // which always trips isMarginal (HF < 1.1×min ≈ 1.87) → capacity would be 0 for every
      // market. 1.5× HF≈2.58 clears the proximity band so Morpho/curve can bind (SPEC006 impl note).
      "single leverage > 1 (default 1.5). Comma grids are invalid — use loop brief for multi-L",
      "1.5",
    ),
).action(async function (this: Command) {
  await runAction(this, "loop capacity", async (config) => {
    const options = this.opts<
      LoopSizingGridOptions & {
        fromChain?: boolean;
        planningBlock?: string;
        allowOfflineDefaults?: boolean;
        targetLeverage?: string;
      }
    >();
    const wantsJson = this.optsWithGlobals<GlobalOptions>().json;
    const leverageRaw = options.targetLeverage ?? "1.5";
    if (leverageRaw.includes(",")) {
      throw new CliError(
        "INVALID_INPUT",
        "loop capacity accepts a single --target-leverage; use loop brief for a leverage grid",
      );
    }

    const inputMode = resolveCapacityInputMode(options);

    try {
      if (inputMode === "from-chain") {
        assertFromChainCompatibleOptions(options);
        const planningBlock =
          options.planningBlock === undefined
            ? undefined
            : BigInt(parseStrictInteger(options.planningBlock, "--planning-block"));
        let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>>;
        try {
          client = await createViemLoopSimulationClient(config);
        } catch (error) {
          throw new CliError(
            "FROM_CHAIN_SEED_BLOCKED",
            `RPC unavailable for --from-chain seeding: ${errorMessage(error)}`,
          );
        }
        if (client === null) {
          throw new CliError(
            "FROM_CHAIN_SEED_BLOCKED",
            "at least one RPC URL must be configured for --from-chain seeding",
          );
        }
        // Capacity --from-chain: Storage READ only for vault APY (never write brief_runs).
        const store = new Storage(config.storage.sqlitePath);
        try {
          const prepared = await prepareFromChainCapacityTemplate({
            config,
            client,
            options,
            explicitFlags: explicitFlagsFromCommand(this),
            leverage: leverageRaw,
            planningBlock,
            store,
          });
          const quoter = prepared.seedCurve
            ? makeExitSlippageQuoter(config, client)
            : undefined;
          const result = await findLoopCapacity({
            template: prepared.template,
            inputMode,
            blockNumber: prepared.blockNumber,
            quoteExitSlippage: quoter,
            seedProvenance: prepared.seedProvenance,
            authoritative: prepared.authoritative,
            warnings: prepared.warnings,
          });
          return wantsJson ? result : renderLoopCapacityTable(result);
        } finally {
          store.close();
        }
      }

      const template = buildSingleTemplate(config, options, leverageRaw, inputMode);
      const result = await findLoopCapacity({
        template,
        inputMode,
        authoritative: inputMode === "explicit-flags",
        warnings:
          inputMode === "offline-defaults"
            ? ["OFFLINE DEFAULTS — not live capacity"]
            : [],
      });
      return wantsJson ? result : renderLoopCapacityTable(result);
    } catch (error) {
      if (error instanceof CapacitySearchError) {
        throw new CliError(error.code, error.message);
      }
      throw error;
    }
  });
});

addSizingSeedFlags(
  loop
    .command("brief")
    .description(
      "Decision-support brief: capacity grid + net APY snapshot + deltas vs last comparable run",
    )
    .option("--json", "emit JSON envelope")
    .option(
      "--target-leverage <values>",
      // 1.8× HF≈1.935 clears the 1.1×min HF marginal band; 2× does not (always marginal-band).
      "comma-separated leverage grid (default 1.5,1.8)",
      "1.5,1.8",
    )
    .option(
      "--canonical-equity-diem <amount>",
      "equity for net-APY snapshot (default 100)",
      "100",
    ),
).action(async function (this: Command) {
  await runAction(this, "loop brief", async (config) => {
    const options = this.opts<
      LoopSizingGridOptions & {
        fromChain?: boolean;
        planningBlock?: string;
        allowOfflineDefaults?: boolean;
        targetLeverage?: string;
        canonicalEquityDiem?: string;
      }
    >();
    const wantsJson = this.optsWithGlobals<GlobalOptions>().json;
    const leverageRaw = options.targetLeverage ?? "1.5,1.8";
    const canonicalEquityRaw = options.canonicalEquityDiem ?? "100";
    const inputMode = resolveCapacityInputMode(options);

    const leverageParts = leverageRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (leverageParts.length === 0) {
      throw new CliError("INVALID_INPUT", "--target-leverage must include at least one value");
    }

    let canonicalEquityDiem: bigint;
    try {
      canonicalEquityDiem = parseDecimalToUnits(canonicalEquityRaw);
    } catch (error) {
      throw new CliError(
        "INVALID_INPUT",
        error instanceof Error ? error.message : String(error),
      );
    }

    const store = new Storage(config.storage.sqlitePath);
    try {
      const templatesByLeverage = new Map<number, LoopSizingScenario>();
      let capacityOptions: Parameters<typeof buildLoopBrief>[0]["capacityOptions"];
      let blockNumber: bigint | null = null;
      let vaultApySource: "measured-7d" | "not-seeded" | "flag" | null = null;
      let sharedWarnings: string[] = [];
      let sharedAuthoritative = inputMode !== "offline-defaults";

      if (inputMode === "from-chain") {
        assertFromChainCompatibleOptions(options);
        const planningBlock =
          options.planningBlock === undefined
            ? undefined
            : BigInt(parseStrictInteger(options.planningBlock, "--planning-block"));
        let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>>;
        try {
          client = await createViemLoopSimulationClient(config);
        } catch (error) {
          throw new CliError(
            "FROM_CHAIN_SEED_BLOCKED",
            `RPC unavailable for --from-chain seeding: ${errorMessage(error)}`,
          );
        }
        if (client === null) {
          throw new CliError(
            "FROM_CHAIN_SEED_BLOCKED",
            "at least one RPC URL must be configured for --from-chain seeding",
          );
        }
        // Seed once; clone template per leverage.
        const prepared = await prepareFromChainCapacityTemplate({
          config,
          client,
          options,
          explicitFlags: explicitFlagsFromCommand(this),
          leverage: leverageParts[0],
          planningBlock,
          store,
        });
        blockNumber = prepared.blockNumber;
        vaultApySource = prepared.vaultApySource ?? null;
        sharedWarnings = prepared.warnings;
        sharedAuthoritative = prepared.authoritative;
        if (prepared.seedCurve) {
          capacityOptions = {
            blockNumber: prepared.blockNumber,
            quoteExitSlippage: makeExitSlippageQuoter(config, client),
            seedProvenance: prepared.seedProvenance,
            authoritative: prepared.authoritative,
            warnings: prepared.warnings,
          };
        } else {
          capacityOptions = {
            seedProvenance: prepared.seedProvenance,
            authoritative: prepared.authoritative,
            warnings: prepared.warnings,
          };
        }
        for (const lev of leverageParts) {
          let leverageBps: number;
          try {
            leverageBps = parseDecimalToBps(lev, "--target-leverage");
          } catch (error) {
            throw new CliError(
              "INVALID_INPUT",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (leverageBps <= 10_000) {
            throw new CliError("INVALID_INPUT", "--target-leverage values must be greater than 1");
          }
          templatesByLeverage.set(leverageBps, {
            ...prepared.template,
            id: `brief-${leverageBps}`,
            targetLeverageBps: leverageBps,
          });
        }
      } else {
        for (const lev of leverageParts) {
          const template = buildSingleTemplate(config, options, lev, inputMode);
          templatesByLeverage.set(template.targetLeverageBps, template);
        }
        if (inputMode === "offline-defaults") {
          sharedWarnings = ["OFFLINE DEFAULTS — not live capacity"];
          sharedAuthoritative = false;
        }
        if (this.getOptionValueSource("vaultApyBps") === "cli") {
          vaultApySource = "flag";
        }
      }

      const leverageGridBps = [...templatesByLeverage.keys()].sort((a, b) => a - b);
      const firstTemplate = templatesByLeverage.get(leverageGridBps[0]);
      if (firstTemplate === undefined) {
        throw new CliError("INVALID_INPUT", "no leverage templates built");
      }
      const templateFingerprint = fingerprintFromTemplate(
        firstTemplate,
        inputMode,
        leverageGridBps,
        canonicalEquityDiem,
      );
      const previous =
        inputMode === "offline-defaults"
          ? null
          : store.getLatestComparableBriefRun({
              inputMode,
              templateFingerprint,
            });

      let brief;
      try {
        brief = await buildLoopBrief({
          templatesByLeverage,
          leverageGridBps,
          canonicalEquityDiem,
          inputMode,
          chainId: config.chainId,
          blockNumber,
          vaultApySource,
          previous,
          capacityOptions: {
            ...capacityOptions,
            authoritative: sharedAuthoritative,
            warnings: [
              ...(capacityOptions?.warnings ?? []),
              ...sharedWarnings.filter(
                (w) => !(capacityOptions?.warnings ?? []).includes(w),
              ),
            ],
          },
        });
      } catch (error) {
        if (error instanceof CapacitySearchError) {
          throw new CliError(error.code, error.message);
        }
        throw error;
      }

      if (brief.current.persistable) {
        store.insertBriefRun(brief.current);
      }

      return wantsJson ? brief : renderLoopBrief(brief);
    } finally {
      store.close();
    }
  });
});

loop
  .command("simulate")
  .description("Dry-run only")
  .requiredOption("--action <action>", "open|rebalance|exit")
  .option("--target-leverage <number>", "target leverage")
  .option("--initial-diem <amount>", "initial DIEM amount")
  .option("--slippage-bps <bps>", "slippage bps")
  .option("--owner <address>", "owner override")
  .option("--from <address>", "transaction sender/operator override")
  .option("--live", "run RPC-backed preflight and executor simulation when config allows", false)
  .option("--force", "for exit only: skip slippage guard while keeping simulation mandatory", false)
  .action(async function (this: Command) {
    await runAction(this, "loop simulate", async (config) => {
      const opts = this.opts<{
        action: "open" | "rebalance" | "exit";
        targetLeverage?: string;
        initialDiem?: string;
        slippageBps?: string;
        owner?: string;
        from?: string;
        live?: boolean;
        force?: boolean;
      }>();
      if (!["open", "rebalance", "exit"].includes(opts.action)) {
        throw new CliError("INVALID_INPUT", "--action must be open, rebalance, or exit");
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const commandOptions = {
        action: opts.action,
        targetLeverage:
          opts.targetLeverage === undefined
            ? undefined
            : parseStrictFloat(opts.targetLeverage, "--target-leverage"),
        initialDiem: opts.initialDiem,
        slippageBps:
          opts.slippageBps === undefined
            ? undefined
            : parseStrictInteger(opts.slippageBps, "--slippage-bps"),
        owner: opts.owner === undefined ? undefined : parseAddress(opts.owner, "--owner"),
        from: opts.from === undefined ? undefined : parseAddress(opts.from, "--from"),
        force: opts.force,
        dryRun: true,
        nowSeconds,
      };
      const projection = projectLoopCommand(config, commandOptions);
      if (!opts.live) {
        return projection;
      }
      const builtParams = buildLoopExecutorParamsForCommand(config, commandOptions);
      const { owner, from } = builtParams;
      let params = builtParams.params;
      let safetyEvidence = buildConfiguredLoopSafetyEvidence(config);
      let exitPlan: Awaited<ReturnType<typeof buildLiveLoopExitPlan>> | undefined;
      let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>>;
      try {
        client = await createViemLoopSimulationClient(config);
      } catch (error) {
        const data = {
          ...projection,
          kind: "live_blocked" as const,
          liveSimulation: {
            status: "blocked" as const,
            action: opts.action,
            preflightChecks: projection.preflightChecks,
            error: {
              code: "RPC_CLIENT_UNAVAILABLE",
              message: errorMessage(error),
            },
          },
        };
        throw new CliError("LIVE_SIMULATION_BLOCKED", errorMessage(error), undefined, data);
      }
      if (opts.action === "exit" && client !== null) {
        exitPlan = await buildLiveLoopExitPlan({
          config,
          owner,
          preflightClient: client,
          routeQuoteClient: client,
          slippageBps: commandOptions.slippageBps ?? config.execution.defaultSlippageBps,
          force: commandOptions.force,
          nowSeconds,
        });
        params = exitPlan.params;
        if (exitPlan.routeSlippage !== undefined) {
          safetyEvidence = {
            ...safetyEvidence,
            routeSlippage: exitPlan.routeSlippage,
          };
        }
        if (exitPlan.flashLoanLiquidity !== undefined) {
          safetyEvidence = {
            ...safetyEvidence,
            flashLoanLiquidity: exitPlan.flashLoanLiquidity,
          };
        }
      }
      const liveSimulation = await simulateLoopExecutorCall({
        config,
        action: opts.action,
        owner,
        from,
        params,
        safetyEvidence,
        client: client ?? undefined,
      });
      const data = {
        ...projection,
        executorParamsAvailable: params !== null,
        liveRouteQuote: exitPlan?.routeQuote,
        liveRouteQuoteReadiness: exitPlan?.readiness,
        liveFlashLoanLiquidity: exitPlan?.flashLoanLiquidity,
        liveMorphoDebtBlockNumber: exitPlan?.morphoDebtBlockNumber,
        kind:
          liveSimulation.status === "passed"
            ? ("live_passed" as const)
            : liveSimulation.status === "failed"
              ? ("live_failed" as const)
              : ("live_blocked" as const),
        liveSimulation,
      };
      if (liveSimulation.status !== "passed") {
        throw new CliError(
          liveSimulation.status === "failed" ? "LIVE_SIMULATION_FAILED" : "LIVE_SIMULATION_BLOCKED",
          liveSimulation.error?.message ?? "Live simulation did not pass",
          undefined,
          data,
        );
      }
      return data;
    });
  });

loop
  .command("authorize-executor")
  .description("Build Morpho executor authorization")
  .option("--owner <address>", "owner override")
  .option(
    "--live",
    "read current authorization and simulate setAuthorization with gas estimate",
    false,
  )
  .option("--dry-run", "simulate only", false)
  .action(async function (this: Command) {
    await runAction(this, "loop authorize-executor", async (config) => {
      const opts = this.opts<{ owner?: string; live?: boolean }>();
      const ownerOption = opts.owner;
      const owner =
        ownerOption === undefined ? config.position.owner : parseAddress(ownerOption, "--owner");
      const projection = projectLoopCommand(config, {
        action: "rebalance",
        targetLeverage: 1.7,
        dryRun: true,
        owner: owner ?? undefined,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (projection.authorizationCalldata === undefined) {
        throw new CliError(
          "AUTHORIZATION_UNAVAILABLE",
          "loopExecutor and owner are required to build Morpho setAuthorization calldata",
        );
      }
      if (!opts.live) {
        return {
          alreadyAuthorized: null,
          dryRun: true,
          note: "RPC authorization read/simulation is required before broadcast.",
          authorizationCalldata: projection.authorizationCalldata,
        };
      }

      let client: Awaited<ReturnType<typeof createViemLoopSimulationClient>>;
      try {
        client = await createViemLoopSimulationClient(config);
      } catch (error) {
        const data = {
          dryRun: true,
          broadcastAvailable: false,
          authorization: {
            status: "blocked" as const,
            owner,
            loopExecutor: config.contracts.loopExecutor,
            alreadyAuthorized: null,
            authorizationCalldata: projection.authorizationCalldata,
            error: {
              code: "RPC_CLIENT_UNAVAILABLE",
              message: errorMessage(error),
            },
          },
        };
        throw new CliError("AUTHORIZATION_LIVE_BLOCKED", errorMessage(error), undefined, data);
      }
      const authorization = await simulateMorphoAuthorization({
        config,
        owner,
        client: client ?? undefined,
      });
      const data = {
        dryRun: true,
        broadcastAvailable: false,
        authorization,
      };
      if (authorization.status !== "passed") {
        throw new CliError(
          authorization.status === "failed"
            ? "AUTHORIZATION_LIVE_FAILED"
            : "AUTHORIZATION_LIVE_BLOCKED",
          authorization.error?.message ?? "Authorization simulation did not pass",
          undefined,
          data,
        );
      }
      return {
        alreadyAuthorized: authorization.alreadyAuthorized,
        dryRun: true,
        broadcastAvailable: false,
        authorization,
      };
    });
  });

loop
  .command("history")
  .description("Read SQLite tx history")
  .option("--limit <number>", "row limit", "20")
  .action(async function (this: Command) {
    await runAction(this, "loop history", (config) => {
      const storage = new Storage(config.storage.sqlitePath);
      try {
        return storage.listTxHistory(
          parseStrictInteger(this.opts<{ limit: string }>().limit, "--limit"),
        );
      } finally {
        storage.close();
      }
    });
  });

const alerts = program.command("alerts").description("Alert utilities");

alerts
  .command("test")
  .description("Send a test alert")
  .option("--severity <severity>", "INFO|WARN|CRITICAL", "INFO")
  .option("--message <message>", "test message", "Test alert from wstdiem-loop-manager")
  .action(async function (this: Command) {
    await runAction(this, "alerts test", async (config) => {
      const opts = this.opts<{ severity: Severity; message: string }>();
      if (!["INFO", "WARN", "CRITICAL"].includes(opts.severity)) {
        throw new CliError("INVALID_INPUT", "--severity must be INFO, WARN, or CRITICAL");
      }
      const snapshot = makeEmptySnapshot();
      const alert = {
        alertKey: "test",
        level: opts.severity,
        message: opts.message,
        suggestedAction: "No action required.",
        cooldownSeconds: 0,
        metrics: {},
      };
      const delivered = await deliverConfiguredAlerts(
        config,
        [alert],
        snapshot.blockNumber,
        snapshot.timestamp,
      );
      return {
        delivered,
        evaluatedAlerts: evaluateAlerts(snapshot, config.thresholds).length,
      };
    });
  });

await program.parseAsync(process.argv);
