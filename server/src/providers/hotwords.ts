import { ServerProviderError, type HotwordEntry } from './types.js';

export interface HotwordCapabilities {
  supported: boolean;
  supportsWeights: boolean;
  maxEntries: number;
  maxTextLength: number;
  minimumWeight?: number;
  maximumWeight?: number;
}

export function prepareHotwords(
  entries: readonly HotwordEntry[],
  language: 'ja' | 'en',
  capabilities: HotwordCapabilities,
): string[] {
  if (!capabilities.supported) return [];

  const selected = entries.filter((entry) => entry.enabled && entry.language === language);
  if (selected.length > capabilities.maxEntries) {
    throw invalidHotwords('ホットワードの件数がプロバイダー上限を超えています。');
  }

  return selected.map((entry) => {
    const text = entry.text.trim();
    if (!text || [...text].length > capabilities.maxTextLength) {
      throw invalidHotwords('ホットワードの文字数がプロバイダー仕様の範囲外です。');
    }
    if (entry.weight !== undefined) {
      if (!capabilities.supportsWeights) {
        throw invalidHotwords('このプロバイダーはホットワードの重みを受け付けません。');
      }
      const minimum = capabilities.minimumWeight ?? Number.NEGATIVE_INFINITY;
      const maximum = capabilities.maximumWeight ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(entry.weight) || entry.weight < minimum || entry.weight > maximum) {
        throw invalidHotwords('ホットワードの重みがプロバイダー仕様の範囲外です。');
      }
    }
    return text;
  });
}

function invalidHotwords(message: string): ServerProviderError {
  return new ServerProviderError('invalid_hotwords', false, message);
}
