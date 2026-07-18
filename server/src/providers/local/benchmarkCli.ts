import { delimiter, resolve } from 'node:path';
import { LocalAudioConverter } from './audioConverter.js';
import { runLocalSttBenchmark } from './benchmarkRunner.js';
import { getLocalModelDefinition } from './localModelRegistry.js';
import { LocalProcessManager } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';
import { WhisperCppProvider } from './whisperCppProvider.js';

interface CliOptions {
  audioPath: string;
  language: 'ja' | 'en';
  modelId: string;
  reference?: string;
  hotwords: string[];
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const model = getLocalModelDefinition(cli.modelId);
  if (!model) throw new LocalSttError('local_model_unknown', 'The selected local STT model is not registered.');
  const dataRoot = resolve(process.cwd(), 'server/data/local-stt');
  const binaryDirectory = resolveOptional(process.env.LOCAL_STT_BINARY_DIR, `${dataRoot}/bin`);
  const modelDirectory = resolveOptional(process.env.LOCAL_STT_MODEL_DIR, `${dataRoot}/models`);
  const temporaryDirectory = resolveOptional(process.env.LOCAL_STT_TEMP_DIR, `${dataRoot}/tmp`);
  const resultDirectory = resolveOptional(process.env.LOCAL_STT_RESULT_DIR, `${dataRoot}/results`);
  const allowedInputRoots = splitRoots(process.env.LOCAL_STT_ALLOWED_INPUT_ROOTS)
    ?? [resolve(dataRoot, 'input')];
  const executablePath = process.env.LOCAL_STT_EXECUTABLE?.trim();
  if (!executablePath) {
    throw new LocalSttError('local_executable_missing', 'LOCAL_STT_EXECUTABLE is not configured.');
  }
  const timeoutMs = readInteger(process.env.LOCAL_STT_TIMEOUT_MS, 600_000, 100, 86_400_000);
  const maxConcurrency = readInteger(process.env.LOCAL_STT_MAX_CONCURRENCY, 1, 1, 8);
  const processes = new LocalProcessManager(maxConcurrency);
  const converter = new LocalAudioConverter({
    ffmpegPath: process.env.LOCAL_STT_FFMPEG_PATH?.trim() || undefined,
    allowedAudioRoots: allowedInputRoots,
    allowedBinaryRoots: [binaryDirectory],
    temporaryDirectory,
    timeoutMs,
  }, processes);
  const provider = new WhisperCppProvider({
    executablePath: resolve(executablePath),
    modelPath: resolve(modelDirectory, model.fileName),
    model,
    allowedBinaryRoots: [binaryDirectory],
    allowedModelRoots: [modelDirectory],
    allowedAudioRoots: [...allowedInputRoots, temporaryDirectory],
    timeoutMs,
    threads: readInteger(process.env.LOCAL_STT_THREADS, 4, 1, 32),
    useOpenVino: false,
  }, processes);
  try {
    const result = await runLocalSttBenchmark({
      provider,
      converter,
      audioPath: resolve(cli.audioPath),
      language: cli.language,
      groundTruthTranscript: cli.reference,
      hotwords: cli.hotwords,
      evaluationFile: resolve(resultDirectory, 'benchmarks.jsonl'),
    });
    console.log(JSON.stringify({
      notice: 'ローカル処理・外部送信なし',
      model: model.displayName,
      modelStorageDirectory: modelDirectory,
      inputFile: resolve(cli.audioPath),
      language: cli.language,
      audioDurationSeconds: result.audioDurationSeconds,
      processingState: 'completed',
      totalProcessingMs: result.totalProcessingMs,
      realTimeFactor: result.realTimeFactor,
      realTimeFactorRating: result.realTimeFactorRating,
      firstResultLatencyMs: result.firstPartialLatencyMs ?? null,
      finalLatencyMs: result.finalLatencyMs ?? null,
      characterErrorRate: result.characterErrorRate ?? null,
      wordErrorRate: result.wordErrorRate ?? null,
      hotwordAccuracy: result.hotwordAccuracy ?? null,
      cpuUsagePercent: result.cpuUsagePercent ?? null,
      peakMemoryBytes: result.peakMemoryBytes ?? null,
      metricsNote: result.cpuUsagePercent === undefined
        ? 'CPU使用率と最大メモリは、この骨格では未計測です。保証値として補完しません。'
        : undefined,
      transcriptSavedToEvaluationFile: true,
      transcriptPrintedToConsole: false,
      externalCommunication: {
        duringAudioProcessing: false,
        modelDownload: 'This command never downloads models.',
      },
      evaluationFile: resolve(resultDirectory, 'benchmarks.jsonl'),
      testedAt: result.testedAt,
    }, null, 2));
  } finally {
    await provider.close();
  }
}

function parseArguments(argumentsList: readonly string[]): CliOptions {
  const normalizedArguments = argumentsList[0] === '--' ? argumentsList.slice(1) : argumentsList;
  const values = new Map<string, string>();
  const hotwords: string[] = [];
  for (let index = 0; index < normalizedArguments.length; index += 2) {
    const key = normalizedArguments[index];
    const value = normalizedArguments[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw usageError();
    if (key === '--hotword') hotwords.push(value);
    else values.set(key, value);
  }
  const audioPath = values.get('--audio');
  const modelId = values.get('--model');
  const language = values.get('--language');
  if (!audioPath || !modelId || (language !== 'ja' && language !== 'en')) throw usageError();
  return { audioPath, modelId, language, reference: values.get('--reference'), hotwords };
}

function usageError(): LocalSttError {
  return new LocalSttError(
    'local_cli_arguments_invalid',
    'Usage: pnpm benchmark:local -- --audio <path> --model <id> --language <ja|en> [--reference <text>] [--hotword <text>]',
  );
}

function resolveOptional(value: string | undefined, fallback: string): string {
  return resolve(value?.trim() || fallback);
}

function splitRoots(value: string | undefined): string[] | undefined {
  const roots = value?.split(delimiter).map((item) => item.trim()).filter(Boolean).map((item) => resolve(item));
  return roots?.length ? roots : undefined;
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LocalSttError('local_config_invalid', 'A local STT numeric setting is invalid.');
  }
  return parsed;
}

void main().catch((error: unknown) => {
  const safeMessage = error instanceof LocalSttError ? error.safeMessage : 'Local STT benchmark failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
