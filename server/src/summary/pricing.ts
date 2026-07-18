export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

export function parsePricingTable(json: string | undefined): PricingTable {
  if (!json) return {};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(value)) {
    if (!price || typeof price !== 'object' || Array.isArray(price)) continue;
    const input = (price as Record<string, unknown>).inputUsdPerMillionTokens;
    const output = (price as Record<string, unknown>).outputUsdPerMillionTokens;
    if (typeof input === 'number' && input >= 0 && typeof output === 'number' && output >= 0) {
      result[model] = { inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output };
    }
  }
  return result;
}

export function estimateCostUsd(
  table: PricingTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = table[model];
  if (!price) return undefined;
  return (inputTokens * price.inputUsdPerMillionTokens + outputTokens * price.outputUsdPerMillionTokens) / 1_000_000;
}
