import { appendFile, mkdir, stat, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, release } from 'node:os';
import { resolve } from 'node:path';
import { inspectPcm16Mono16kWavQuality } from './audioConverter.js';
import {
  runChunkComparisonCondition,
  sha256File,
  type ChunkComparisonCondition,
  type ChunkComparisonRunRecord,
  type RecoveryStatus,
} from './chunkComparison.js';
import { LocalProcessManager } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

const AUDIO_SHA256 = '1e9be7f2d175934a8e72956da797f693efa22c645b1dd64f09ccee7209cb9575';
const MODEL_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
const EXECUTABLE_SHA256 = '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755';

export const SPOKEN_REFERENCE = [
  'えっと、今日は議事録アプリの開発状況について話します。',
  'えっと、現在は音声認識にWhisper smallというモデルを使う予定です。以前試したWhisper baseは処理速度がかなり速かったのですが、日本語や英語の認識精度、特に専門用語や固有名詞の認識に問題がありました。',
  'Whisper smallを試したところ、処理には少し時間がかかるようになりましたが、文字起こしの精度は大きく改善しました。例えば、人工知能、音声認識、WebSocketなどの言葉は、以前より正確に認識できています。',
  'ただし、大阪公立大学やOpenVINOのような固有名詞は、まだ間違って認識されることがあります。そのため、今後は専門用語の辞書や、会議の前に登録した単語を使って、認識精度を改善したいと考えています。',
  '最終的には、マイクから取得した音声をWebSocketでサーバーへ送り、ローカル環境で文字起こしを行います。そして、確定した文章を要約AIへ送り、会議中には重要な論点や決定事項を表示します。',
  '今回は、話す途中で少し止まったり、言い直したりした場合でも、どの程度正しく文字起こしできるのかを確認します。',
].join(' ');

export const TARGET_PHRASES = [
  '文字起こしの精度は大きく改善しました。',
  '最終的には、マイクから取得した音声をWebSocketでサーバーへ送り、ローカル環境で文字起こしを行います。',
] as const;

const CONDITIONS: readonly ChunkComparisonCondition[] = [
  { label: 'whole-no-timestamps', evaluationMode: 'whole-no-timestamps', chunkDurationMs: null, overlapDurationMs: 0, timestamps: false },
  { label: 'whole-with-timestamps', evaluationMode: 'whole-with-timestamps', chunkDurationMs: null, overlapDurationMs: 0, timestamps: true },
  { label: 'chunk-15s-no-overlap', evaluationMode: 'chunk-no-overlap', chunkDurationMs: 15_000, overlapDurationMs: 0, timestamps: false },
  { label: 'chunk-20s-no-overlap', evaluationMode: 'chunk-no-overlap', chunkDurationMs: 20_000, overlapDurationMs: 0, timestamps: false },
  { label: 'chunk-30s-no-overlap', evaluationMode: 'chunk-no-overlap', chunkDurationMs: 30_000, overlapDurationMs: 0, timestamps: false },
  { label: 'chunk-15s-overlap-2s', evaluationMode: 'chunk-overlap', chunkDurationMs: 15_000, overlapDurationMs: 2_000, timestamps: false },
  { label: 'chunk-20s-overlap-2s', evaluationMode: 'chunk-overlap', chunkDurationMs: 20_000, overlapDurationMs: 2_000, timestamps: false },
  { label: 'chunk-30s-overlap-2s', evaluationMode: 'chunk-overlap', chunkDurationMs: 30_000, overlapDurationMs: 2_000, timestamps: false },
];

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLocaleLowerCase() === 'true') {
    throw new LocalSttError('external_stt_must_be_disabled', 'STT_EXTERNAL_ENABLED must remain false for the chunk comparison benchmark.');
  }
  if (process.env.LOCAL_STT_THREADS?.trim() && process.env.LOCAL_STT_THREADS.trim() !== '4') {
    throw new LocalSttError('local_threads_invalid', 'The chunk comparison benchmark requires LOCAL_STT_THREADS=4.');
  }
  const root = resolve(process.cwd(), 'server/data/local-stt');
  const inputRoot = resolve(root, 'input');
  const modelRoot = resolve(root, 'models');
  const binaryRoot = resolve(root, 'bin');
  const temporaryRoot = resolve(root, 'temp');
  const resultRoot = resolve(root, 'results');
  const audioPath = resolve(inputRoot, 'natural-ja.wav');
  const modelPath = resolve(modelRoot, 'ggml-small-q5_1.bin');
  const executablePath = resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
  const [audioSha256, modelSha256, executableSha256] = await Promise.all([
    sha256File(audioPath), sha256File(modelPath), sha256File(executablePath),
  ]);
  verifyHash(audioSha256, AUDIO_SHA256, 'local_audio_hash_mismatch');
  verifyHash(modelSha256, MODEL_SHA256, 'local_model_hash_mismatch');
  verifyHash(executableSha256, EXECUTABLE_SHA256, 'local_executable_hash_mismatch');
  const wav = await inspectPcm16Mono16kWavQuality(audioPath, [inputRoot]);
  const [modelStat, executableStat, drive] = await Promise.all([
    stat(modelPath), stat(executablePath), statfs(resolve('C:/')),
  ]);
  await mkdir(resultRoot, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const resultBase = resolve(resultRoot, `whisper-small-q5_1-japanese-chunk-comparison-${timestamp}`);
  const jsonlPath = `${resultBase}.jsonl`;
  const metadataPath = `${resultBase}.metadata.json`;
  const reportPath = `${resultBase}.md`;
  await writeFile(jsonlPath, '', { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  const processManager = new LocalProcessManager(1);
  const records: ChunkComparisonRunRecord[] = [];
  const common = {
    audioPath,
    modelPath,
    executablePath,
    inputRoot,
    modelRoot,
    binaryRoot,
    temporaryRoot,
    spokenReference: SPOKEN_REFERENCE,
    targetPhrases: TARGET_PHRASES,
    audioSha256,
    modelSha256,
    processManager,
    timeoutMs: 900_000,
  } as const;
  try {
    for (let index = 0; index < CONDITIONS.length; index += 1) {
      const condition = CONDITIONS[index];
      if (!condition) continue;
      process.stdout.write(`[${index + 1}/${CONDITIONS.length}] ${condition.label}: local CPU evaluation started\n`);
      const record = await runChunkComparisonCondition({ ...common, condition, runType: 'initial', runNumber: 1 });
      records.push(record);
      await appendFile(jsonlPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      process.stdout.write(`[${index + 1}/${CONDITIONS.length}] ${condition.label}: completed (transcript suppressed)\n`);
    }
    const bestInitial = selectBestCondition(records);
    const bestCondition = CONDITIONS.find((condition) => condition.label === bestInitial.conditionLabel);
    if (!bestCondition) throw new Error('Selected benchmark condition is unavailable.');
    for (let runNumber = 2; runNumber <= 3; runNumber += 1) {
      process.stdout.write(`[warm ${runNumber}/3] ${bestCondition.label}: local CPU evaluation started\n`);
      const record = await runChunkComparisonCondition({ ...common, condition: bestCondition, runType: 'warm', runNumber });
      records.push(record);
      await appendFile(jsonlPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      process.stdout.write(`[warm ${runNumber}/3] ${bestCondition.label}: completed (transcript suppressed)\n`);
    }
  } finally {
    await processManager.close();
  }
  const selectedRecords = records.filter((record) => record.conditionLabel === selectBestCondition(records.filter((record) => record.runType === 'initial')).conditionLabel);
  const metadata = {
    provider: 'local-whisper',
    model: 'whisper-small-q5_1',
    language: 'ja',
    evaluationPurpose: 'Compare whole-file timestamps and PCM chunking for confirmed long-form omissions.',
    processingLocation: 'local',
    audioSentExternally: false,
    sttExternalEnabled: false,
    realtimeWebSocketUsed: false,
    gpuEnabled: false,
    openVinoEnabled: false,
    whisperCppVersion: 'v1.9.1',
    windowsVersion: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalProcessorCount: availableParallelism(),
    availableMemoryBytesBefore: freemem(),
    cDriveFreeBytesBefore: drive.bavail * drive.bsize,
    threadCount: 4,
    input: { path: audioPath, sha256: audioSha256, wav },
    modelFile: { path: modelPath, sizeBytes: modelStat.size, sha256: modelSha256 },
    executable: { path: executablePath, sizeBytes: executableStat.size, sha256: executableSha256 },
    spokenReference: SPOKEN_REFERENCE,
    targetPhrases: TARGET_PHRASES,
    conditions: CONDITIONS,
    initialRunCount: CONDITIONS.length,
    selectedCondition: selectedRecords[0]?.conditionLabel ?? null,
    selectedConditionRunCount: selectedRecords.length,
    totalRunCount: records.length,
    transcriptPrintedToConsole: false,
    firstResultTimeAvailable: false,
    startedAt: records[0]?.testedAt ?? null,
    completedAt: new Date().toISOString(),
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  await writeFile(reportPath, buildMarkdownReport(records, metadata), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: 'completed',
    runCount: records.length,
    selectedCondition: metadata.selectedCondition,
    jsonlPath,
    metadataPath,
    reportPath,
    transcriptPrintedToConsole: false,
    externalCommunicationDuringInference: false,
  }, null, 2)}\n`);
}

export function selectBestCondition(records: readonly ChunkComparisonRunRecord[]): ChunkComparisonRunRecord {
  const initial = records.filter((record) => record.runType === 'initial');
  if (initial.length === 0) throw new RangeError('At least one initial condition is required.');
  const recoveredCount = (record: ChunkComparisonRunRecord): number =>
    recoveryScore(record.targetPhrase1Recovery.status) + recoveryScore(record.targetPhrase2Recovery.status);
  const deployableCandidates = initial.filter((record) =>
    record.chunkDurationMs !== null && record.bothTargetPhrasesRecovered && record.realTimeFactor <= 1);
  const candidatePool = deployableCandidates.length > 0 ? deployableCandidates : initial;
  const maximumRecovered = Math.max(...candidatePool.map(recoveredCount));
  const recoveredCandidates = candidatePool.filter((record) => recoveredCount(record) === maximumRecovered);
  const minimumCer = Math.min(...recoveredCandidates.map((record) => record.normalizedCer));
  const comparableAccuracy = recoveredCandidates.filter((record) => record.normalizedCer <= minimumCer + 0.005);
  return [...comparableAccuracy].sort((left, right) => {
    const realtimeDifference = Number(right.realTimeFactor <= 1) - Number(left.realTimeFactor <= 1);
    if (realtimeDifference !== 0) return realtimeDifference;
    const leftLatency = left.chunkDurationMs ?? Number.POSITIVE_INFINITY;
    const rightLatency = right.chunkDurationMs ?? Number.POSITIVE_INFINITY;
    if (leftLatency !== rightLatency) return leftLatency - rightLatency;
    if (left.normalizedCer !== right.normalizedCer) return left.normalizedCer - right.normalizedCer;
    return left.realTimeFactor - right.realTimeFactor;
  })[0]!;
}

function recoveryScore(status: RecoveryStatus): number {
  if (status === 'exactRecovered') return 3;
  if (status === 'substantiallyRecovered') return 2;
  if (status === 'partiallyRecovered') return 1;
  return 0;
}

function verifyHash(actual: string, expected: string, code: string): void {
  if (actual !== expected) throw new LocalSttError(code, 'A required local STT file failed SHA-256 verification.');
}

function buildMarkdownReport(records: readonly ChunkComparisonRunRecord[], metadata: Record<string, unknown>): string {
  const initial = records.filter((record) => record.runType === 'initial');
  const selected = String(metadata.selectedCondition ?? 'notAvailable');
  const selectedRuns = records.filter((record) => record.conditionLabel === selected);
  const median = (values: number[]): number => {
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle]! : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
  };
  const lines = [
    '# Whisper small Q5_1 日本語チャンク比較',
    '',
    '- ローカルCPU処理のみ。外部送信なし。GPU／OpenVINOなし。threads=4。',
    '- RTF分類はこのPC・音声・設定での目安であり、性能保証ではありません。',
    '- 認識全文はJSONLにのみ保存し、通常コンソールには出力していません。',
    '',
    '| 条件 | raw CER | normalized CER | 対象1 | 対象2 | chunks | time ms | RTF | CPU avg % | CPU peak % | peak WS bytes | removed duplicates | error |',
    '|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...initial.map((record) => `| ${record.conditionLabel} | ${(record.rawCer * 100).toFixed(2)}% | ${(record.normalizedCer * 100).toFixed(2)}% | ${record.targetPhrase1Recovery.status} | ${record.targetPhrase2Recovery.status} | ${record.chunkCount} | ${record.processingTimeMs.toFixed(2)} | ${record.realTimeFactor.toFixed(4)} | ${formatNullable(record.processCpuAveragePercent)} | ${formatNullable(record.processCpuPeakPercent)} | ${record.peakWorkingSetBytes ?? 'null'} | ${record.removedDuplicateParts.length} | ${record.errorCode ?? ''} |`),
    '',
    `## 選択条件: ${selected}`,
    '',
    `- 3回の処理時間中央値: ${selectedRuns.length ? median(selectedRuns.map((record) => record.processingTimeMs)).toFixed(2) : 'notAvailable'} ms`,
    `- 3回のRTF中央値: ${selectedRuns.length ? median(selectedRuns.map((record) => record.realTimeFactor)).toFixed(4) : 'notAvailable'}`,
    `- run間の認識一致: ${selectedRuns.length ? String(new Set(selectedRuns.map((record) => record.deduplicatedTranscript)).size === 1) : 'notAvailable'}`,
    '',
    '## タイムスタンプセグメント',
    '',
    ...(initial.find((record) => record.evaluationMode === 'whole-with-timestamps')?.segmentTimestamps.map((segment) =>
      `- ${formatTimestamp(segment.startMs)}–${formatTimestamp(segment.endMs)}: ${segment.text}`) ?? ['- notAvailable']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function formatNullable(value: number | null): string {
  return value === null ? 'null' : value.toFixed(2);
}

function formatTimestamp(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(3)}s`;
}

void main().catch((error: unknown) => {
  const safeMessage = error instanceof LocalSttError ? error.safeMessage : 'Local chunk comparison benchmark failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
