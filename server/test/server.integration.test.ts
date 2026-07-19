// @vitest-environment node
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { encodeAudioFrame, parseServerMessage } from '../../shared/protocol';
import { loadServerConfig, type ServerConfig } from '../src/config';
import { createTranscriptionServer, type RunningTranscriptionServer } from '../src/server';

const runningServers: RunningTranscriptionServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

function testConfig(): ServerConfig {
  return {
    ...loadServerConfig({}),
    host: '127.0.0.1',
    port: 0,
    websocketPath: '/transcription',
    allowedOrigins: new Set(['http://localhost:5173']),
    maxSessions: 4,
    sessionResumeTtlMs: 120_000,
    connectionTimeoutMs: 5_000,
    audioIdleTimeoutMs: 5_000,
    provider: 'mock',
    externalEnabled: false,
    hotwordsEnabled: false,
    requestTimeoutMs: 15_000,
  };
}

async function startServer(): Promise<{ server: RunningTranscriptionServer; address: AddressInfo }> {
  const server = createTranscriptionServer({ config: testConfig() });
  runningServers.push(server);
  return { server, address: await server.start() };
}

describe('transcription server integration', () => {
  it('serves the health endpoint without API keys', async () => {
    const apiKey = 'test-key-not-real';
    const workspaceId = 'workspace-test';
    const server = createTranscriptionServer({ config: { ...testConfig(), apiKey, workspaceId } });
    runningServers.push(server);
    const address = await server.start();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: 'ok', provider: 'mock', localSttEnabled: false,
    });
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(JSON.stringify(body)).not.toContain(workspaceId);
  });

  it('accepts WebSocket audio and returns ready, transcript, and stopped', async () => {
    const { address } = await startServer();
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/transcription`, {
      origin: 'http://localhost:5173',
    });
    await waitForOpen(websocket);

    const readyPromise = nextMessage(websocket);
    websocket.send(JSON.stringify({
      type: 'start',
      sessionId: 'integration-session',
      language: 'en',
      audioFormat: 'audio/webm;codecs=opus',
    }));
    expect(await readyPromise).toEqual({ type: 'ready', sessionId: 'integration-session' });

    const transcriptPromise = nextMessage(websocket);
    websocket.send(encodeAudioFrame('integration-session', 0, new Uint8Array([1, 2, 3]).buffer));
    expect(await transcriptPromise).toMatchObject({
      type: 'transcript',
      sessionId: 'integration-session',
      language: 'en',
      isFinal: false,
    });

    const finalAndStopped = collectMessages(websocket, 2);
    websocket.send(JSON.stringify({ type: 'stop', sessionId: 'integration-session' }));
    expect(await finalAndStopped).toEqual([
      expect.objectContaining({ type: 'transcript', isFinal: true }),
      { type: 'stopped', sessionId: 'integration-session' },
    ]);
    websocket.close();
  });

  it('resumes a disconnected WebSocket and acknowledges replay without duplicate processing', async () => {
    const { address } = await startServer();
    const first = new WebSocket(`ws://127.0.0.1:${address.port}/transcription`, {
      origin: 'http://localhost:5173',
    });
    await waitForOpen(first);
    const ready = nextMessage(first);
    first.send(JSON.stringify({
      type: 'start', sessionId: 'resume-integration', language: 'ja', audioFormat: 'audio/webm;codecs=opus',
    }));
    expect(await ready).toEqual({ type: 'ready', sessionId: 'resume-integration' });

    const initialMessages = collectMessages(first, 2);
    first.send(encodeAudioFrame('resume-integration', 0, new Uint8Array([1]).buffer));
    expect((await initialMessages).map(({ type }) => type)).toEqual(['transcript', 'audio_ack']);
    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.terminate();
    await closed;

    const resumedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/transcription`, {
      origin: 'http://localhost:5173',
    });
    await waitForOpen(resumedSocket);
    const resumed = nextMessage(resumedSocket);
    resumedSocket.send(JSON.stringify({
      type: 'resume', sessionId: 'resume-integration', language: 'ja',
      audioFormat: 'audio/webm;codecs=opus', lastAcknowledgedSequence: -1,
    }));
    expect(await resumed).toEqual({
      type: 'resumed', sessionId: 'resume-integration', lastReceivedSequence: 0,
    });

    const replayAck = nextMessage(resumedSocket);
    resumedSocket.send(encodeAudioFrame('resume-integration', 0, new Uint8Array([1]).buffer));
    expect(await replayAck).toEqual({ type: 'audio_ack', sessionId: 'resume-integration', sequence: 0 });

    const continuedMessages = collectMessages(resumedSocket, 2);
    resumedSocket.send(encodeAudioFrame('resume-integration', 1, new Uint8Array([2]).buffer));
    expect((await continuedMessages).map(({ type }) => type)).toEqual(['transcript', 'audio_ack']);
    resumedSocket.close();
  });

  it('serves mock incremental summaries without an OpenAI API key', async () => {
    const server = createTranscriptionServer({
      config: testConfig(),
      summaryConfig: {
        enabled: true,
        provider: 'mock',
        liveReasoningEffort: 'low',
        finalReasoningEffort: 'medium',
        intervalSeconds: 10,
        stopOnBudgetExceeded: true,
      },
    });
    runningServers.push(server);
    const address = await server.start();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/summary/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        meetingId: 'meeting-1', previousSummary: null,
        newSentences: [{ id: 'sentence-1', text: '完成文です。', startTime: 0, endTime: 1 }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      keyPoints: [{ evidenceSentenceIds: ['sentence-1'] }],
    });
  });
});

function waitForOpen(websocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    websocket.once('open', resolve);
    websocket.once('error', reject);
  });
}

function nextMessage(websocket: WebSocket): Promise<ReturnType<typeof parseServerMessage>> {
  return new Promise((resolve, reject) => {
    websocket.once('message', (data: RawData) => {
      try {
        resolve(parseServerMessage(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    websocket.once('error', reject);
  });
}

function collectMessages(websocket: WebSocket, count: number): Promise<ReturnType<typeof parseServerMessage>[]> {
  return new Promise((resolve, reject) => {
    const messages: ReturnType<typeof parseServerMessage>[] = [];
    const onMessage = (data: RawData): void => {
      try {
        messages.push(parseServerMessage(data.toString()));
        if (messages.length === count) {
          websocket.off('message', onMessage);
          resolve(messages);
        }
      } catch (error) {
        reject(error);
      }
    };
    websocket.on('message', onMessage);
    websocket.once('error', reject);
  });
}
