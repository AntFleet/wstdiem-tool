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
import type { AppConfig, Severity } from "../types/domain.js";
import { CliError, toCliError } from "./errors.js";
import { assertBroadcastNotAllowed, buildLoopExecutorParamsForCommand, projectLoopCommand } from "./loop.js";
import { jsonEnvelope, printJson, renderLoopReadinessTable, renderStatusTable, stringifyJson } from "./output.js";
import { parseAddress, parseStrictFloat, parseStrictInteger } from "./parse.js";
import { buildStatus, runWatchOnce } from "./status.js";

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

const AUDIT_GATE_BLOCKER = "broadcast disabled pending production executor audit/review";

function assertStrictLoopReadinessEvidence(result: LoopReadinessResult): void {
  const auditGate = result.checks.find((check) => check.key === "audit-gate");
  const nonAuditIssues = result.checks.filter((check) => check.key !== "audit-gate" && check.status !== "pass");
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
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return result;
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
        throw new CliError("NOT_IMPLEMENTED", "Persistent TUI is not implemented in this slice; use watch --once");
      }
      const result = await runWatchOnce(config);
      if (this.optsWithGlobals<GlobalOptions>().json) {
        return result;
      }
      return renderStatusTable(result.snapshot, result.readiness);
    });
  });

const loop = program.command("loop").description("Loop position commands");

loop
  .command("readiness")
  .description("Read live Curve, Morpho, executor, and owner exit readiness")
  .option("--owner <address>", "position owner override")
  .option("--loop-executor <address>", "loopExecutor override for live readiness evidence")
  .option("--strict-evidence", "exit non-zero unless all live evidence checks pass except the closed audit gate", false)
  .action(async function (this: Command) {
    await runAction(this, "loop readiness", async (config) => {
      const opts = this.opts<{ owner?: string; loopExecutor?: string; strictEvidence?: boolean }>();
      const ownerOption = opts.owner;
      const owner = ownerOption === undefined ? config.position.owner : parseAddress(ownerOption, "--owner");
      if (opts.loopExecutor !== undefined) {
        config = {
          ...config,
          contracts: { ...config.contracts, loopExecutor: parseAddress(opts.loopExecutor, "--loop-executor") },
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
          opts.slippageBps === undefined ? undefined : parseStrictInteger(opts.slippageBps, "--slippage-bps"),
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
          opts.slippageBps === undefined ? undefined : parseStrictInteger(opts.slippageBps, "--slippage-bps"),
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
  .option("--live", "read current authorization and simulate setAuthorization with gas estimate", false)
  .option("--dry-run", "simulate only", false)
  .action(async function (this: Command) {
    await runAction(this, "loop authorize-executor", async (config) => {
      const opts = this.opts<{ owner?: string; live?: boolean }>();
      const ownerOption = opts.owner;
      const owner = ownerOption === undefined ? config.position.owner : parseAddress(ownerOption, "--owner");
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
          authorization.status === "failed" ? "AUTHORIZATION_LIVE_FAILED" : "AUTHORIZATION_LIVE_BLOCKED",
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
        return storage.listTxHistory(parseStrictInteger(this.opts<{ limit: string }>().limit, "--limit"));
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
