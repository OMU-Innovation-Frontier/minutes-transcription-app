// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { loadCorrectionConfig } from '../src/correction/config';
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
