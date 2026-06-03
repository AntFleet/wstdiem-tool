import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig, Hex, MetricSnapshot } from "../types/domain.js";
import type { BaseApyEvidence, LoopSafetyEvidence, SignerEvidence } from "./types.js";

export function buildConfiguredSignerEvidence(config: AppConfig): SignerEvidence | undefined {
  if (config.wallet.hardware.enabled) {
    return undefined;
  }
  const privateKey = process.env[config.wallet.privateKeyEnv]?.trim();
  if (privateKey === undefined || privateKey === "") {
    return undefined;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error(`Invalid private key in ${config.wallet.privateKeyEnv}; expected 0x-prefixed 32-byte hex`);
  }
  const account = privateKeyToAccount(privateKey as Hex);
  return {
    source: "configured-wallet",
    address: account.address,
    verified: true,
  };
}

export function buildBaseApyEvidenceFromSnapshot(
  config: AppConfig,
  snapshot: MetricSnapshot,
): BaseApyEvidence | undefined {
  if (!snapshot.validity.yieldWindow || !snapshot.validity.vault || !snapshot.validity.rpcFreshness) {
    return undefined;
  }
  if (snapshot.blockNumber < 0n || !Number.isFinite(snapshot.baseApy) || snapshot.baseApy < 0) {
    return undefined;
  }
  return {
    source: "metrics-snapshot",
    chainId: config.chainId,
    blockNumber: snapshot.blockNumber,
    windowSeconds: 7 * 24 * 60 * 60,
    baseApy: snapshot.baseApy,
    valid: true,
  };
}

export function buildConfiguredLoopSafetyEvidence(config: AppConfig, snapshot?: MetricSnapshot): LoopSafetyEvidence {
  return {
    baseApy: snapshot === undefined ? undefined : buildBaseApyEvidenceFromSnapshot(config, snapshot),
    signer: buildConfiguredSignerEvidence(config),
  };
}
