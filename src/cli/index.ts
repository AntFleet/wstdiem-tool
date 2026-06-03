#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { deliverConfiguredAlerts } from "../alerts/deliver.js";
import { evaluateAlerts } from "../alerts/evaluate.js";
import { makeEmptySnapshot } from "../metrics/math.js";
import { Storage } from "../storage/sqlite.js";
import { createViemLoopSimulationClient } from "../contracts/loopSimulationClient.js";
import { simulateMorphoAuthorization } from "../loop/authorization.js";
import { buildConfiguredLoopSafetyEvidence } from "../loop/safetyEvidence.js";
import { simulateLoopExecutorCall } from "../loop/simulator.js";
import type { AppConfig, Severity } from "../types/domain.js";
import { CliError, toCliError } from "./errors.js";
import { assertBroadcastNotAllowed, buildLoopExecutorParamsForCommand, projectLoopCommand } from "./loop.js";
import { jsonEnvelope, printJson, renderStatusTable } from "./output.js";
import { parseAddress, parseStrictFloat, parseStrictInteger } from "./parse.js";
import { buildStatus, runWatchOnce } from "./status.js";

interface GlobalOptions {
  config?: string;
  json?: boolean;
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
      console.log(JSON.stringify(data, null, 2));
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
        dryRun: true,
        nowSeconds,
      };
      const projection = projectLoopCommand(config, commandOptions);
      if (!opts.live) {
        return projection;
      }
      const { owner, from, params } = buildLoopExecutorParamsForCommand(config, commandOptions);
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
      const liveSimulation = await simulateLoopExecutorCall({
        config,
        action: opts.action,
        owner,
        from,
        params,
        safetyEvidence: buildConfiguredLoopSafetyEvidence(config),
        client: client ?? undefined,
      });
      const data = {
        ...projection,
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
