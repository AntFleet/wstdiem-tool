export const UNISWAP_V3_FLASH_FEE_DENOMINATOR = 1_000_000n;

export const ALLOWED_UNISWAP_V3_FEE_TIERS = new Set([100, 500, 3_000, 10_000]);

export function expectedUniswapV3FlashFee(amount: bigint, feeTier: number | null): bigint | null {
  if (feeTier === null || !ALLOWED_UNISWAP_V3_FEE_TIERS.has(feeTier)) {
    return null;
  }
  const numerator = amount * BigInt(feeTier);
  return numerator === 0n ? 0n : ((numerator - 1n) / UNISWAP_V3_FLASH_FEE_DENOMINATOR) + 1n;
}
