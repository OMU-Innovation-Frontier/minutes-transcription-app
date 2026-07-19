import { ServerProviderError } from '../types.js';

export const FUN_ASR_SINGAPORE_REGION = 'singapore';
export const FUN_ASR_SINGAPORE_WORKSPACE_SUFFIX = 'ap-southeast-1.maas.aliyuncs.com';
export const FUN_ASR_WEBSOCKET_PATH = '/api-ws/v1/inference';

const MAX_WORKSPACE_ID_LENGTH = 63;
const MAX_API_KEY_LENGTH = 4_096;
const FORBIDDEN_WORKSPACE_CHARACTERS = new Set([
  '.', '/', '\\', ':', '@', '?', '#', '%', '[', ']',
]);

export function resolveFunAsrSingaporeEndpoint(
  region: string | undefined,
  workspaceId: string | undefined,
  configuredEndpoint: string | undefined,
): string {
  if (region !== FUN_ASR_SINGAPORE_REGION) {
    throw configurationError('fun_asr_region_unsupported');
  }
  if (configuredEndpoint !== undefined) {
    throw configurationError('fun_asr_transport_configuration_invalid');
  }
  assertFunAsrWorkspaceId(workspaceId);
  const endpoint = `wss://${workspaceId}.${FUN_ASR_SINGAPORE_WORKSPACE_SUFFIX}${FUN_ASR_WEBSOCKET_PATH}`;
  assertFunAsrSingaporeEndpoint(endpoint, workspaceId);
  return endpoint;
}

export function assertFunAsrWorkspaceId(value: string | undefined): asserts value is string {
  if (value === undefined || value.length === 0) {
    throw configurationError('fun_asr_workspace_missing');
  }
  if (
    value.length > MAX_WORKSPACE_ID_LENGTH
    || value.trim() !== value
    || containsWhitespaceOrControl(value)
    || [...value].some((character) => FORBIDDEN_WORKSPACE_CHARACTERS.has(character))
  ) {
    throw configurationError('fun_asr_workspace_invalid');
  }
}

export function assertFunAsrSingaporeEndpoint(value: string, workspaceId: string): void {
  assertFunAsrWorkspaceId(workspaceId);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw configurationError('fun_asr_transport_configuration_invalid');
  }
  const expectedHostname = `${workspaceId}.${FUN_ASR_SINGAPORE_WORKSPACE_SUFFIX}`.toLowerCase();
  if (
    endpoint.protocol !== 'wss:'
    || endpoint.hostname !== expectedHostname
    || endpoint.port !== ''
    || endpoint.pathname !== FUN_ASR_WEBSOCKET_PATH
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || endpoint.username !== ''
    || endpoint.password !== ''
  ) {
    throw configurationError('fun_asr_transport_configuration_invalid');
  }
}

export function assertFunAsrApiKey(value: string | undefined): asserts value is string {
  if (
    value === undefined
    || value.length === 0
    || value.length > MAX_API_KEY_LENGTH
    || value.trim() !== value
    || containsWhitespaceOrControl(value)
  ) {
    throw configurationError('fun_asr_api_key_missing');
  }
}

function containsWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined
      || codePoint <= 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) return true;
  }
  return false;
}

export function assertFunAsrModel(model: string | undefined): asserts model is 'fun-asr-realtime' {
  if (model !== 'fun-asr-realtime') throw configurationError('fun_asr_model_unsupported');
}

function configurationError(code: string): ServerProviderError {
  const messages: Record<string, string> = {
    fun_asr_api_key_missing: 'Fun-ASR server credential is not configured.',
    fun_asr_workspace_missing: 'Fun-ASR workspace is not configured.',
    fun_asr_workspace_invalid: 'Fun-ASR workspace configuration is invalid.',
    fun_asr_region_unsupported: 'Fun-ASR region is not supported.',
    fun_asr_model_unsupported: 'Fun-ASR model is not supported.',
    fun_asr_transport_configuration_invalid: 'Fun-ASR transport configuration is invalid.',
  };
  return new ServerProviderError(code, false, messages[code] ?? 'Fun-ASR transport configuration failed.');
}
