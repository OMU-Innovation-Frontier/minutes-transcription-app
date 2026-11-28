export const SONIX_RECORDING_LIMIT_MS = 10 * 60_000;
export const MEETING_RECORDING_LIMIT_MS = 2 * 60 * 60_000;
export const SONIX_PROCESSING_LIMIT_MS = 8 * 60_000;

export function isSpeakerLabel(value: unknown): value is string {
  return typeof value === 'string' && /^話者(?:[A-Z]{1,4}|不明)$/u.test(value);
}

export function isSpeakerName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && value.trim() === value
    && value.length > 0 && [...value].every(character => character >= ' ' && character !== '\u007f');
}
