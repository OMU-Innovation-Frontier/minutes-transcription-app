import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  runChunkComparisonCondition,
  sha256File,
  type ChunkComparisonRunRecord,
} from './chunkComparison.js';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

const AUDIO_SHA256 = '1e9be7f2d175934a8e72956da797f693efa22c645b1dd64f09ccee7209cb9575';
const MODEL_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
const EXECUTABLE_SHA256 = '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755';
const CONDITION = {
  label: 'chunk-20s-no-overlap',
  evaluationMode: 'chunk-no-overlap' as const,
  chunkDurationMs: 20_000,
  overlapDurationMs: 0,
  timestamps: false,
};

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLocaleLowerCase() === 'true') {
    throw new LocalSttError('external_stt_must_be_disabled', 'STT_EXTERNAL_ENABLED must remain false for the chunk reproducibility benchmark.');
  }
  if (process.env.LOCAL_STT_THREADS?.trim() && process.env.LOCAL_STT_THREADS.trim() !== '4') {
    throw new LocalSttError('local_threads_invalid', 'The chunk reproducibility benchmark requires LOCAL_STT_THREADS=4.');
  }
  const baselineFileName = process.env.LOCAL_STT_CHUNK_BASELINE?.trim();
  if (!baselineFileName || /[/\\]/u.test(baselineFileName)) {
    throw new LocalSttError('local_baseline_invalid', 'A safe chunk comparison baseline filename is required.');
  }
  const root = resolve(process.cwd(), 'server/data/local-stt');
  const inputRoot = resolve(root, 'input');
  const modelRoot = resolve(root, 'models');
  const binaryRoot = resolve(root, 'bin');
  const temporaryRoot = resolve(root, 'temp');
  const resultRoot = resolve(root, 'results');
  const baselinePath = await validateExistingFile(resolve(resultRoot, baselineFileName), [resultRoot], 'local_baseline_invalid', 'The chunk comparison baseline is invalid.');
  const metadataPath = await validateExistingFile(baselinePath.replace(/\.jsonl$/u, '.metadata.json'), [resultRoot], 'local_baseline_invalid', 'The chunk comparison metadata is invalid.');
  const [baselineText, metadataText] = await Promise.all([readFile(baselinePath, 'utf8'), readFile(metadataPath, 'utf8')]);
  const baselineRecords = baselineText.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as ChunkComparisonRunRecord);
  const baseline = baselineRecords.find((record) => record.runType === 'initial' && record.conditionLabel === CONDITION.label);
  if (!baseline) throw new LocalSttError('local_baseline_invalid', 'The requested initial chunk condition is absent from the baseline.');
  const metadata = JSON.parse(metadataText) as { spokenReference?: unknown; targetPhrases?: unknown };
  if (typeof metadata.spokenReference !== 'string' || !Array.isArray(metadata.targetPhrases)
    || metadata.targetPhrases.length !== 2 || !metadata.targetPhrases.every((value) => typeof value === 'string')) {
    throw new LocalSttError('local_baseline_invalid', 'The chunk comparison reference metadata is invalid.');
  }
  const spokenReference = metadata.spokenReference;
  const targetPhrases = metadata.targetPhrases as [string, string];
  const audioPath = resolve(inputRoot, 'natural-ja.wav');
  const modelPath = resolve(modelRoot, 'ggml-small-q5_1.bin');
  const executablePath = resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
  const [audioSha256, modelSha256, executableSha256] = await Promise.all([
    sha256File(audioPath), sha256File(modelPath), sha256File(executablePath),
  ]);
  verifyHash(audioSha256, AUDIO_SHA256, 'local_audio_hash_mismatch');
  verifyHash(modelSha256, MODEL_SHA256, 'local_model_hash_mismatch');
  verifyHash(executableSha256, EXECUTABLE_SHA256, 'local_executable_hash_mismatch');
  const processManager = new LocalProcessManager(1);
  const records = [baseline];
  try {
    for (let runNumber = 2; runNumber <= 3; runNumber += 1) {
      process.stdout.write(`[warm ${runNumber}/3] ${CONDITION.label}: local CPU evaluation started\n`);
      records.push(await runChunkComparisonCondition({
        condition: CONDITION,
        audioPath,
        modelPath,
        executablePath,
        inputRoot,
        modelRoot,
        binaryRoot,
        temporaryRoot,
        spokenReference,
        targetPhrases,
        audioSha256,
        modelSha256,
        processManager,
        timeoutMs: 900_000,
        runType: 'warm',
        runNumber,
      }));
      process.stdout.write(`[warm ${runNumber}/3] ${CONDITION.label}: completed (transcript suppressed)\n`);
    }
  } finally {
    await processManager.close();
  }
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const resultBase = resolve(resultRoot, `whisper-small-q5_1-japanese-chunk-20s-reproducibility-${timestamp}`);
  const jsonlPath = `${resultBase}.jsonl`;
  const outputMetadataPath = `${resultBase}.metadata.json`;
  const reportPath = `${resultBase}.md`;
  const baselineSha256 = await sha256File(baselinePath);
  await writeFile(jsonlPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  const outputMetadata = {
    purpose: 'Reproducibility confirmation for the best real-time-applicable initial condition.',
    condition: CONDITION,
    runCount: records.length,
    baseline: { path: baselinePath, sha256: baselineSha256, copiedInitialRecord: true },
    hashes: { audioSha256, modelSha256, executableSha256 },
    audioSentExternally: false,
    sttExternalEnabled: false,
    realtimeWebSocketUsed: false,
    transcriptPrintedToConsole: false,
    createdAt: new Date().toISOString(),
  };
  await writeFile(outputMetadataPath, `${JSON.stringify(outputMetadata, null, 2)}\n`, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  const rows = records.map((record) =>
    `| ${record.runNumber} | ${record.runType} | ${record.processingTimeMs.toFixed(2)} | ${record.realTimeFactor.toFixed(4)} | ${(record.normalizedCer * 100).toFixed(2)}% | ${record.targetPhrase1Recovery.status} | ${record.targetPhrase2Recovery.status} | ${record.processCpuAveragePercent?.toFixed(2) ?? 'null'} | ${record.processCpuPeakPercent?.toFixed(2) ?? 'null'} | ${record.peakWorkingSetBytes ?? 'null'} |`);
  await writeFile(reportPath, [
    '# 20秒・重なりなし 再現性確認', '',
    '- ローカルCPUのみ、threads=4、外部送信なし。',
    '- run 1は監査可能性のため元比較JSONLからコピーし、run 2–3だけ追加実測。', '',
    '| run | type | time ms | RTF | normalized CER | target 1 | target 2 | CPU avg % | CPU peak % | peak WS bytes |',
    '|---:|---|---:|---:|---:|---|---|---:|---:|---:|', ...rows, '',
  ].join('\n'), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: 'completed', condition: CONDITION.label, runCount: records.length, jsonlPath, metadataPath: outputMetadataPath, reportPath, transcriptPrintedToConsole: false }, null, 2)}\n`);
}

function verifyHash(actual: string, expected: string, code: string): void {
  if (actual !== expected) throw new LocalSttError(code, 'A required local STT file failed SHA-256 verification.');
}

void main().catch((error: unknown) => {
  const safeMessage = error instanceof LocalSttError ? error.safeMessage : 'Local chunk reproducibility benchmark failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
