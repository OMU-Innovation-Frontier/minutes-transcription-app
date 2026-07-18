import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { LocalAudioConverter } from './audioConverter.js';
import { runLocalBenchmarkSuite, type LocalBenchmarkCase } from './benchmarkSuite.js';
import { getLocalModelDefinition } from './localModelRegistry.js';
import { LocalProcessManager } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';
import { WhisperCppProvider } from './whisperCppProvider.js';

const MODEL_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
const EXECUTABLE_SHA256 = '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755';

const CASES: readonly Omit<LocalBenchmarkCase, 'audioPath'>[] = [
  {
    language: 'ja',
    testCaseId: 'natural-ja-v1',
    reference: [
      '今日は、議事録アプリの開発状況について話します。',
      'えっと、現在は音声認識にWhisper smallというモデルを使う予定です。以前試したWhisper baseは処理速度がかなり速かったのですが、日本語や英語の認識精度、特に専門用語や固有名詞の認識に問題がありました。',
      'Whisper smallを試したところ、処理には少し時間がかかるようになりましたが、文字起こしの精度は大きく改善しました。例えば、人工知能、音声認識、WebSocketなどの言葉は、以前より正確に認識できています。',
      'ただし、大阪公立大学やOpenVINOのような固有名詞は、まだ間違って認識されることがあります。そのため、今後は専門用語の辞書や、会議の前に登録した単語を使って、認識精度を改善したいと考えています。',
      '最終的には、マイクから取得した音声をWebSocketでサーバーへ送り、ローカル環境で文字起こしを行います。そして、確定した文章を要約AIへ送り、会議中には重要な論点や決定事項を表示します。',
      '今回は、話す途中で少し止まったり、言い直したりした場合でも、どの程度正しく文字起こしできるのかを確認します。',
    ].join(' '),
    spokenReference: null,
    hotwords: ['Whisper small', 'Whisper base', '人工知能', '音声認識', 'WebSocket', '大阪公立大学', 'OpenVINO', '要約AI', '決定事項'],
  },
  {
    language: 'en',
    testCaseId: 'natural-en-v1',
    reference: [
      'Today, I am going to talk about the current development of our meeting transcription application.',
      'Well, we are planning to use a model called Whisper small for speech recognition. The Whisper base model was very fast, but its recognition accuracy was not good enough, especially for technical vocabulary and proper names.',
      'After testing Whisper small, the processing time became longer, but the transcription accuracy improved significantly. For example, it recognized terms such as artificial intelligence, speech recognition, WebSocket, and robotics more accurately than the smaller model.',
      'However, it still has difficulty recognizing proper names and technical terms such as Osaka Metropolitan University and OpenVINO. In the future, we may improve this by using a custom vocabulary or by providing important words before the meeting begins.',
      'The final system will send microphone audio to a local server through WebSocket. The local speech recognition model will convert the audio into text, and the confirmed transcript will be sent to a summarization model. During the meeting, the application will display important points, decisions, and action items.',
      'In this test, I will continue speaking even if I pause, make a small mistake, or correct myself.',
    ].join(' '),
    spokenReference: null,
    hotwords: ['Whisper small', 'Whisper base', 'transcription', 'speech recognition', 'artificial intelligence', 'WebSocket', 'robotics', 'Osaka Metropolitan University', 'OpenVINO', 'summarization model', 'action items'],
  },
];

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLocaleLowerCase() === 'true') {
    throw new LocalSttError('external_stt_must_be_disabled', 'STT_EXTERNAL_ENABLED must remain false for the natural speech benchmark.');
  }
  if (process.env.LOCAL_STT_THREADS?.trim() && process.env.LOCAL_STT_THREADS.trim() !== '4') {
    throw new LocalSttError('local_threads_invalid', 'The natural speech benchmark requires LOCAL_STT_THREADS=4.');
  }
  const root = resolve(process.cwd(), 'server/data/local-stt');
  const binaryRoot = resolve(root, 'bin');
  const modelRoot = resolve(root, 'models');
  const inputRoot = resolve(root, 'input');
  const resultRoot = resolve(root, 'results');
  const executablePath = resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
  const model = getLocalModelDefinition('whisper-small-q5_1');
  if (!model || model.provider !== 'local-whisper') {
    throw new LocalSttError('local_model_unknown', 'Whisper small Q5_1 is not registered.');
  }
  const modelPath = resolve(modelRoot, model.fileName);
  await verifySha256(modelPath, MODEL_SHA256, 'local_model_hash_mismatch');
  await verifySha256(executablePath, EXECUTABLE_SHA256, 'local_executable_hash_mismatch');
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const resultBase = resolve(resultRoot, `whisper-small-q5_1-natural-speech-cpu-${timestamp}`);
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
    threads: 4,
    useOpenVino: false,
  }, processes);
  try {
    const suite = await runLocalBenchmarkSuite({
      provider,
      converter,
      modelPath,
      cases: CASES.map((benchmarkCase) => ({
        ...benchmarkCase,
        audioPath: resolve(inputRoot, `natural-${benchmarkCase.language}.wav`),
      })),
      resultsJsonlPath: `${resultBase}.jsonl`,
      metadataPath: `${resultBase}.metadata.json`,
      warmRuns: 3,
    });
    process.stdout.write(`${JSON.stringify({
      notice: 'ローカル処理・外部送信なし',
      status: 'completed',
      model: suite.metadata.model,
      runCount: suite.records.length,
      resultsJsonlPath: `${resultBase}.jsonl`,
      metadataPath: `${resultBase}.metadata.json`,
      spokenReferenceStatus: 'unverified',
      transcriptPrintedToConsole: false,
    }, null, 2)}\n`);
  } finally {
    await provider.close();
  }
}

async function verifySha256(filePath: string, expected: string, code: string): Promise<void> {
  const actual = await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
  if (actual !== expected) throw new LocalSttError(code, 'A required local STT file failed SHA-256 verification.');
}

void main().catch((error: unknown) => {
  const safeMessage = error instanceof LocalSttError ? error.safeMessage : 'Natural speech benchmark failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
