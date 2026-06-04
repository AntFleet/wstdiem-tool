/* global console, process, URL */

const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX32 = /^0x[a-fA-F0-9]{64}$/;

const required = ["BASE_RPC_URL", "WSTDIEM_FORK_LOOP_EXECUTOR", "WSTDIEM_FORK_OWNER"];
const optionalAddresses = [
  "WSTDIEM_FORK_INFERENCE_VAULT",
  "WSTDIEM_FORK_CURVE_POOL",
  "WSTDIEM_FORK_MORPHO_ORACLE",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireValue(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    fail(`${name} is required`);
  }
  return value;
}

function requireAddress(name) {
  const value = requireValue(name);
  if (!ADDRESS.test(value)) {
    fail(`${name} must be a valid EVM address`);
  }
  if (ZERO_ADDRESS.test(value)) {
    fail(`${name} must not be the zero address`);
  }
}

try {
  new URL(requireValue("BASE_RPC_URL"));
} catch {
  fail("BASE_RPC_URL must be a valid URL");
}

for (const name of required.slice(1)) {
  requireAddress(name);
}

for (const name of optionalAddresses) {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    requireAddress(name);
  }
}

const marketId = process.env.WSTDIEM_FORK_MARKET_ID;
if (marketId !== undefined && marketId !== "") {
  if (!HEX32.test(marketId)) {
    fail("WSTDIEM_FORK_MARKET_ID must be a 32-byte hex value");
  }
  if (/^0x0{64}$/i.test(marketId)) {
    fail("WSTDIEM_FORK_MARKET_ID must not be zero");
  }
}
