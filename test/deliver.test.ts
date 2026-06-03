import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { deliverConfiguredAlerts } from "../src/alerts/deliver.js";

describe("alert delivery safety", () => {
  it("redacts webhook URLs in delivery results and continues after channel failure", async () => {
    const secretUrl = "http://127.0.0.1:9/services/SECRET";
    const delivered = await deliverConfiguredAlerts(
      {
        ...DEFAULT_CONFIG,
        alerts: {
          ...DEFAULT_CONFIG.alerts,
          webhookUrls: [secretUrl],
        },
      },
      [
        {
          alertKey: "test",
          level: "INFO",
          message: "test",
          suggestedAction: "none",
          cooldownSeconds: 0,
          metrics: {},
        },
      ],
      0n,
      1,
    );
    expect(delivered.join(" ")).not.toContain("SECRET");
    expect(delivered.some((entry) => entry.startsWith("webhook:127.0.0.1:9#1:failed"))).toBe(true);
  });
});
