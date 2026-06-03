import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { morphoAbi } from "../abi/morpho.js";
import { missingDeploymentKeys } from "../config/load.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import type { PreflightCheck } from "./types.js";

export interface LoopPreflightClient {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<Hex>;
  readContract(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

function check(key: string, status: PreflightCheck["status"], message: string): PreflightCheck {
  return { key, status, message };
}

export function hasPreflightFailures(checks: PreflightCheck[]): boolean {
  return checks.some((entry) => entry.status === "fail");
}

export function staticLoopPreflight(config: AppConfig, owner: Address | null): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const missing = missingDeploymentKeys(config);
  checks.push(
    check(
      "deployment-config",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? "required deployment config is present" : `missing: ${missing.join(", ")}`,
    ),
  );
  checks.push(
    check("owner", owner === null ? "fail" : "pass", owner === null ? "missing position.owner or --owner" : "owner present"),
  );
  checks.push(
    check(
      "rpc-config",
      config.rpc.primaryUrl !== null || config.rpc.fallbackUrls.length > 0 ? "pass" : "fail",
      config.rpc.primaryUrl !== null || config.rpc.fallbackUrls.length > 0
        ? "at least one RPC URL configured"
        : "missing RPC URL",
    ),
  );
  return checks;
}

export async function runLoopPreflight(
  config: AppConfig,
  owner: Address | null,
  client?: LoopPreflightClient,
): Promise<PreflightCheck[]> {
  const checks = staticLoopPreflight(config, owner);
  if (client === undefined || hasPreflightFailures(checks)) {
    checks.push(
      check(
        "onchain-preflight",
        client === undefined ? "skip" : "fail",
        client === undefined
          ? "no preflight client provided; chain/code/contract reads not run"
          : "static preflight failed; on-chain preflight skipped",
      ),
    );
    return checks;
  }

  const chainId = await client.getChainId();
  checks.push(
    check(
      "chain-id",
      chainId === config.chainId ? "pass" : "fail",
      chainId === config.chainId ? `chainId ${chainId}` : `unexpected chainId ${chainId}; expected ${config.chainId}`,
    ),
  );

  const requiredContracts = [
    ["diem", config.contracts.diem],
    ["morphoBlue", config.contracts.morphoBlue],
    ["inferenceVault", config.contracts.inferenceVault],
    ["feeRouter", config.contracts.feeRouter],
    ["curvePool", config.contracts.curvePool],
    ["morphoOracle", config.contracts.morphoOracle],
    ["loopExecutor", config.contracts.loopExecutor],
  ] as const;
  for (const [name, address] of requiredContracts) {
    if (address === null) {
      continue;
    }
    const code = await client.getCode(address);
    checks.push(
      check("contract-code", code === "0x" ? "fail" : "pass", code === "0x" ? `${name} has no code` : `${name} has code`),
    );
  }

  if (config.contracts.inferenceVault !== null) {
    const asset = (await client.readContract({
      address: config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "asset",
    })) as Address;
    checks.push(
      check(
        "vault-asset",
        asset.toLowerCase() === config.contracts.diem.toLowerCase() ? "pass" : "fail",
        asset.toLowerCase() === config.contracts.diem.toLowerCase()
          ? "vault.asset() matches DIEM"
          : `vault.asset() ${asset} does not match DIEM ${config.contracts.diem}`,
      ),
    );
  }

  if (owner !== null && config.contracts.loopExecutor !== null) {
    const authorized = (await client.readContract({
      address: config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "isAuthorized",
      args: [owner, config.contracts.loopExecutor],
    })) as boolean;
    checks.push(
      check(
        "morpho-authorization",
        authorized ? "pass" : "fail",
        authorized ? "loopExecutor is authorized by owner" : "owner has not authorized loopExecutor in Morpho",
      ),
    );
  }

  return checks;
}
