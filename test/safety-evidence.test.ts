import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildBaseApyEvidenceFromSnapshot, buildConfiguredSignerEvidence } from "../src/loop/safetyEvidence.js";
import { makeEmptySnapshot } from "../src/metrics/math.js";

const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const privateKeyEnv = "WSTDIEM_TEST_PRIVATE_KEY";

afterEach(() => {
  delete process.env[privateKeyEnv];
});

describe("loop safety evidence", () => {
  it("derives verified signer evidence from configured private key env", () => {
    process.env[privateKeyEnv] = privateKey;
    const evidence = buildConfiguredSignerEvidence({
      ...DEFAULT_CONFIG,
      wallet: {
        ...DEFAULT_CONFIG.wallet,
        privateKeyEnv,
      },
    });
    expect(evidence).toMatchObject({
      source: "configured-wallet",
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      verified: true,
    });
  });

  it("fails closed when no configured private key is present", () => {
    expect(
      buildConfiguredSignerEvidence({
        ...DEFAULT_CONFIG,
        wallet: {
          ...DEFAULT_CONFIG.wallet,
          privateKeyEnv,
        },
      }),
    ).toBeUndefined();
  });

  it("fails closed for hardware wallets until a hardware signer adapter exists", () => {
    process.env[privateKeyEnv] = privateKey;
    expect(
      buildConfiguredSignerEvidence({
        ...DEFAULT_CONFIG,
        wallet: {
          ...DEFAULT_CONFIG.wallet,
          privateKeyEnv,
          hardware: {
            ...DEFAULT_CONFIG.wallet.hardware,
            enabled: true,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed configured private keys without echoing the secret", () => {
    process.env[privateKeyEnv] = "not-a-private-key";
    expect(() =>
      buildConfiguredSignerEvidence({
        ...DEFAULT_CONFIG,
        wallet: {
          ...DEFAULT_CONFIG.wallet,
          privateKeyEnv,
        },
      }),
    ).toThrow(`Invalid private key in ${privateKeyEnv}`);
  });

  it("builds base APY evidence only from a valid yield-window metric snapshot", () => {
    const snapshot = {
      ...makeEmptySnapshot(),
      blockNumber: 123n,
      baseApy: 0.18,
      validity: {
        ...makeEmptySnapshot().validity,
        vault: true,
        yieldWindow: true,
        rpcFreshness: true,
      },
    };
    expect(buildBaseApyEvidenceFromSnapshot(DEFAULT_CONFIG, snapshot)).toMatchObject({
      source: "metrics-snapshot",
      chainId: 8453,
      blockNumber: 123n,
      windowSeconds: 604_800,
      baseApy: 0.18,
      valid: true,
    });
  });

  it("fails closed when base APY snapshot validity or values are unsafe", () => {
    const validSnapshot = {
      ...makeEmptySnapshot(),
      blockNumber: 123n,
      baseApy: 0.18,
      validity: {
        ...makeEmptySnapshot().validity,
        vault: true,
        yieldWindow: true,
        rpcFreshness: true,
      },
    };
    expect(
      buildBaseApyEvidenceFromSnapshot(DEFAULT_CONFIG, {
        ...validSnapshot,
        validity: { ...validSnapshot.validity, yieldWindow: false },
      }),
    ).toBeUndefined();
    expect(buildBaseApyEvidenceFromSnapshot(DEFAULT_CONFIG, { ...validSnapshot, baseApy: Number.NaN })).toBeUndefined();
    expect(buildBaseApyEvidenceFromSnapshot(DEFAULT_CONFIG, { ...validSnapshot, baseApy: -0.01 })).toBeUndefined();
  });
});
