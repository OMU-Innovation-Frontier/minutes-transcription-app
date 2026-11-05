// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { loadCorrectionConfig } from '../src/correction/config';
import { createCorrectionService } from '../src/correction/correctionService';
import { loadServerConfig } from '../src/config';
import { createTranscriptionServer, type RunningTranscriptionServer } from '../src/server';

const servers: RunningTranscriptionServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('correction HTTP integration', () => {
  it('reports correction disabled by default', async () => {
    const { address } = await startServer(false);
    const response = await fetch(`http://127.0.0.1:${address}/api/correction/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false, provider: 'mock', externalTransmission: false, concurrency: 1,
    });
  });

  it('runs deterministic mock correction without an external API', async () => {
    const { address } = await startServer(true);
    const response = await fetch(`http://127.0.0.1:${address}/api/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        input: {
          targetSegmentId: 'sentence-1', targetRawText: 'こんにちわ', previousSegments: [], language: 'ja',
          glossary: [], correctionPolicyVersion: 'safe-correction-v1', removeFillers: false,
          sourceSegmentIds: ['session-1:segment-1'],
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rawText: 'こんにちわ', correctedText: 'こんにちは。', status: 'completed', provider: 'mock',
    });
  });

  it('serves Groq status and correction through the existing endpoint with injected HTTP only', async () => {
    const fetchMock = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({
          correctedText: 'the plan',
          changes: [{ before: 'teh', after: 'the', reason: 'spelling' }],
          uncertainParts: [],
        }) },
      }],
    }), { headers: { 'content-type': 'application/json' } });
    const correctionConfig = loadCorrectionConfig({
      LLM_CORRECTION_ENABLED: 'true',
      LLM_CORRECTION_PROVIDER: 'groq',
      GROQ_CORRECTION_API_KEY: 'test-key',
      GROQ_CORRECTION_MODEL: 'openai/gpt-oss-20b',
    });
    const server = createTranscriptionServer({
      config: { ...loadServerConfig({}), host: '127.0.0.1', port: 0 },
      correctionService: createCorrectionService(correctionConfig, { fetch: fetchMock }),
    });
    servers.push(server);
    const address = (await server.start()).port;
    const statusResponse = await fetch(`http://127.0.0.1:${address}/api/correction/status`);
    const statusText = await statusResponse.text();
    expect(statusText).not.toContain('test-key');
    expect(JSON.parse(statusText)).toMatchObject({
      enabled: true, provider: 'groq', model: 'openai/gpt-oss-20b', externalTransmission: true,
      timeoutMs: 8000, concurrency: 1, maxInputChars: 4000, removeFillers: false,
      policyVersion: 'safe-correction-v1', queueLimit: 100, maxAttempts: 3,
    });
    const response = await fetch(`http://127.0.0.1:${address}/api/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'request-1', meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'sentence-1', revision: 0, attemptCount: 1,
        input: {
          targetSegmentId: 'sentence-1', targetRawText: 'teh plan', previousSegments: [], language: 'en',
          glossary: [], correctionPolicyVersion: 'safe-correction-v1', removeFillers: false,
          sourceSegmentIds: ['raw-1'],
        },
      }),
    });
    expect(await response.json()).toMatchObject({
      rawText: 'teh plan', correctedText: 'the plan', status: 'completed', provider: 'groq', model: 'openai/gpt-oss-20b',
    });
  });
});

async function startServer(enabled: boolean): Promise<{ address: number }> {
  const server = createTranscriptionServer({
    config: { ...loadServerConfig({}), host: '127.0.0.1', port: 0 },
    correctionConfig: loadCorrectionConfig({ LLM_CORRECTION_ENABLED: String(enabled) }),
  });
  servers.push(server);
  const address = await server.start();
  return { address: address.port };
}
