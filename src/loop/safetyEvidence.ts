import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig, Hex } from "../types/domain.js";
import type { LoopSafetyEvidence, SignerEvidence } from "./types.js";

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

export function buildConfiguredLoopSafetyEvidence(config: AppConfig): LoopSafetyEvidence {
  return {
    signer: buildConfiguredSignerEvidence(config),
  };
}
