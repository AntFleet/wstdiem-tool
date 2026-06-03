import { describe, expect, it } from "vitest";
import { parseAddress, parseStrictFloat, parseStrictInteger } from "../src/cli/parse.js";

describe("strict CLI parsing", () => {
  it("rejects partial and non-finite numeric values", () => {
    expect(() => parseStrictFloat("2abc", "--target-leverage")).toThrow(/decimal number/);
    expect(() => parseStrictFloat("NaN", "--target-leverage")).toThrow(/decimal number/);
    expect(() => parseStrictInteger("3abc", "--slippage-bps")).toThrow(/integer/);
    expect(() => parseStrictInteger("-1", "--limit")).toThrow(/integer/);
  });

  it("accepts valid numeric values", () => {
    expect(parseStrictFloat("2.5", "--target-leverage")).toBe(2.5);
    expect(parseStrictInteger("300", "--slippage-bps")).toBe(300);
  });

  it("validates EVM addresses", () => {
    expect(parseAddress("0x0000000000000000000000000000000000000001", "--owner")).toBe(
      "0x0000000000000000000000000000000000000001",
    );
    expect(() => parseAddress("not-an-address", "--owner")).toThrow(/valid EVM address/);
  });
});
