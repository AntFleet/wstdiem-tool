import { isAddress } from "viem";
import { CliError } from "./errors.js";
import type { Address } from "../types/domain.js";

export function parseStrictFloat(value: string, name: string): number {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new CliError("INVALID_INPUT", `${name} must be a decimal number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError("INVALID_INPUT", `${name} must be finite`);
  }
  return parsed;
}

export function parseStrictInteger(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError("INVALID_INPUT", `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError("INVALID_INPUT", `${name} exceeds the safe integer range`);
  }
  return parsed;
}

export function parseAddress(value: string, name: string): Address {
  if (!isAddress(value)) {
    throw new CliError("INVALID_INPUT", `${name} must be a valid EVM address`);
  }
  return value as Address;
}
