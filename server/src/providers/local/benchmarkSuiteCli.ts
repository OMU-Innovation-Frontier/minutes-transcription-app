import { resolve } from 'node:path';
import { LocalAudioConverter } from './audioConverter.js';
import { runLocalBenchmarkSuite, type LocalBenchmarkCase } from './benchmarkSuite.js';
import { getLocalModelDefinition } from './localModelRegistry.js';
import { LocalProcessManager } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';
import { WhisperCppProvider } from './whisperCppProvider.js';

const CASES: readonly Omit<LocalBenchmarkCase, 'audioPath'>[] = [
  {
    language: 'ja',
    reference: '本日はリアルタイム文字起こしシステムの動作確認を行います。音声認識の速度、精度、専門用語の認識結果を比較します。大阪公立大学では人工知能とロボット技術について研究しています。WebSocketとOpenVINOについても確認します。',
    hotwords: ['大阪公立大学', '人工知能', '音声認識', 'WebSocket', 'OpenVINO'],
  },
  {
    language: 'en',
    reference: 'Today, we are testing a real-time transcription system. We will compare recognition speed, accuracy, and technical vocabulary. Artificial intelligence and robotics are important fields of research. We will also test WebSocket, OpenVINO, and transcription.',
    hotwords: ['transcription', 'artificial intelligence', 'robotics', 'WebSocket', 'OpenVINO'],
  },
];

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLocaleLowerCase() === 'true') {
    throw new LocalSttError('external_stt_must_be_disabled', 'STT_EXTERNAL_ENABLED must remain false for the local benchmark suite.');
  }
  const root = resolve(process.cwd(), 'server/data/local-stt');
  const binaryRoot = resolve(root, 'bin');
  const modelRoot = resolve(root, 'models');
  const inputRoot = resolve(root, 'input');
  const resultRoot = resolve(root, 'results');
  const executablePath = resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
  const modelId = process.env.LOCAL_STT_MODEL_ID?.trim() || 'whisper-base-q5_1';
  const model = getLocalModelDefinition(modelId);
  if (!model || model.provider !== 'local-whisper') {
    throw new LocalSttError('local_model_unknown', 'The selected whisper.cpp model is not registered.');
  }
  const modelPath = resolve(modelRoot, model.fileName);
  const threads = readThreads(process.env.LOCAL_STT_THREADS);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const resultBase = resolve(resultRoot, `${model.id}-cpu-${timestamp}`);
  const processes = new LocalProcessManager(1);
  const converter = new LocalAudioConverter({
    allowedAudioRoots: [inputRoot],
    allowedBinaryRoots: [binaryRoot],
    temporaryDirectory: resolve(root, 'tmp'),
    timeoutMs: 600_000,
  }, processes);
  const provider = new WhisperCppProvider({
    executablePath,
    modelPath,
    model,
    allowedBinaryRoots: [binaryRoot],
    allowedModelRoots: [modelRoot],
    allowedAudioRoots: [inputRoot],
    timeoutMs: 600_000,
    threads,
    useOpenVino: false,
  }, processes);
  try {
    const suite = await runLocalBenchmarkSuite({
      provider,
      converter,
      modelPath,
      cases: CASES.map((benchmarkCase) => ({
        ...benchmarkCase,
        audioPath: resolve(inputRoot, `${benchmarkCase.language}.wav`),
      })),
      resultsJsonlPath: `${resultBase}.jsonl`,
      metadataPath: `${resultBase}.metadata.json`,
      warmRuns: 3,
    });
    process.stdout.write(`${JSON.stringify({
      notice: 'ローカル処理・外部送信なし',
      status: 'completed',
      model: suite.metadata.model,
      languages: suite.metadata.cases.map((item) => item.language),
      runCount: suite.records.length,
      coldRuns: suite.records.filter((item) => item.runType === 'cold').length,
      warmRuns: suite.records.filter((item) => item.runType === 'warm').length,
      resultsJsonlPath: `${resultBase}.jsonl`,
      metadataPath: `${resultBase}.metadata.json`,
      transcriptPrintedToConsole: false,
    }, null, 2)}\n`);
  } finally {
    await provider.close();
  }
}

function readThreads(value: string | undefined): number {
  if (!value?.trim()) return 4;
  const threads = Number(value);
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) {
    throw new LocalSttError('local_threads_invalid', 'LOCAL_STT_THREADS must be an integer from 1 to 32.');
  }
  return threads;
}

void main().catch((error: unknown) => {
  const safeMessage = error instanceof LocalSttError ? error.safeMessage : 'Local STT benchmark suite failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
