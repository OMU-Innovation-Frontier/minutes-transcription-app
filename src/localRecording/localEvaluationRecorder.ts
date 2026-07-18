import {
  encodePcm16MonoWav,
  inspectAudioQuality,
  inspectPcm16Mono16kWav,
  resampleMono,
  type AudioQualityInspection,
  type WavFormatInspection,
} from './wavCodec';

type RecordingLanguage = 'ja' | 'en';

const PROMPTS: Record<RecordingLanguage, string> = {
  ja: '本日はリアルタイム文字起こしシステムの動作確認を行います。\n音声認識の速度、精度、専門用語の認識結果を比較します。\n大阪公立大学では人工知能とロボット技術について研究しています。\nWebSocketとOpenVINOについても確認します。',
  en: 'Today, we are testing a real-time transcription system.\nWe will compare recognition speed, accuracy, and technical vocabulary.\nArtificial intelligence and robotics are important fields of research.\nWe will also test WebSocket, OpenVINO, and transcription.',
};

interface RecordedWav {
  language: RecordingLanguage;
  fileName: string;
  url: string;
  blob: Blob;
  format: WavFormatInspection;
  quality: AudioQualityInspection;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} was not found.`);
  return element as T;
}

export class LocalEvaluationRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private mutedOutput?: GainNode;
  private chunks: Float32Array[] = [];
  private sourceSampleRate = 0;
  private startedAt = 0;
  private timer?: number;
  private language?: RecordingLanguage;
  private recording?: RecordedWav;

  private readonly elements = {
    jaButton: requiredElement<HTMLButtonElement>('local-record-ja'),
    enButton: requiredElement<HTMLButtonElement>('local-record-en'),
    stopButton: requiredElement<HTMLButtonElement>('local-record-stop'),
    downloadButton: requiredElement<HTMLButtonElement>('local-record-download'),
    duration: requiredElement<HTMLOutputElement>('local-record-duration'),
    level: requiredElement<HTMLProgressElement>('local-record-level'),
    levelLabel: requiredElement<HTMLOutputElement>('local-record-level-label'),
    prompt: requiredElement<HTMLElement>('local-record-prompt'),
    language: requiredElement<HTMLElement>('local-record-language'),
    status: requiredElement<HTMLElement>('local-record-status'),
    validation: requiredElement<HTMLElement>('local-record-validation'),
    quality: requiredElement<HTMLElement>('local-record-quality'),
    player: requiredElement<HTMLAudioElement>('local-record-player'),
  };

  constructor() {
    this.elements.jaButton.addEventListener('click', () => void this.start('ja'));
    this.elements.enButton.addEventListener('click', () => void this.start('en'));
    this.elements.stopButton.addEventListener('click', () => void this.stop());
    this.elements.downloadButton.addEventListener('click', () => this.download());
    this.renderIdle();
  }

  async start(language: RecordingLanguage): Promise<void> {
    if (this.stream) return;
    this.releaseRecording();
    this.language = language;
    this.chunks = [];
    this.elements.prompt.textContent = PROMPTS[language];
    this.elements.language.textContent = language === 'ja' ? '日本語 / ja.wav' : 'English / en.wav';
    this.elements.status.textContent = 'マイク接続中';
    this.renderControls(true);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, Math.max(1, source.channelCount), 1);
      const mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      processor.onaudioprocess = (event) => this.capture(event.inputBuffer);
      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
      this.stream = stream;
      this.context = context;
      this.source = source;
      this.processor = processor;
      this.mutedOutput = mutedOutput;
      this.sourceSampleRate = context.sampleRate;
      this.startedAt = performance.now();
      this.elements.status.textContent = '録音中（認識経路・外部送信には接続していません）';
      this.timer = window.setInterval(() => this.renderDuration(performance.now() - this.startedAt), 100);
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      await context?.close().catch(() => undefined);
      this.elements.status.textContent = microphoneErrorMessage(error);
      this.renderControls(false);
    }
  }

  async stop(): Promise<void> {
    if (!this.stream || !this.context || !this.language) return;
    const language = this.language;
    const duration = performance.now() - this.startedAt;
    this.stopGraph();
    await this.context.close().catch(() => undefined);
    this.context = undefined;
    this.renderDuration(duration);
    const input = concatenate(this.chunks);
    if (input.length === 0 || this.sourceSampleRate <= 0) {
      this.elements.status.textContent = '録音サンプルを取得できませんでした。';
      this.renderControls(false);
      return;
    }
    const resampled = resampleMono(input, this.sourceSampleRate);
    const wav = encodePcm16MonoWav(resampled);
    const format = inspectPcm16Mono16kWav(wav);
    const quality = inspectAudioQuality(resampled);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    this.recording = { language, fileName: `${language}.wav`, url, blob, format, quality };
    this.elements.player.src = url;
    this.elements.player.hidden = false;
    this.renderResult(format, quality);
    this.renderControls(false);
  }

  dispose(): void {
    this.stopGraph();
    void this.context?.close();
    this.context = undefined;
    this.releaseRecording();
  }

  private capture(buffer: AudioBuffer): void {
    const output = new Float32Array(buffer.length);
    const channels = Math.max(1, buffer.numberOfChannels);
    for (let channel = 0; channel < channels; channel += 1) {
      const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      for (let index = 0; index < output.length; index += 1) output[index] = (output[index] ?? 0) + (input[index] ?? 0) / channels;
    }
    this.chunks.push(output);
    let squareSum = 0;
    for (const sample of output) squareSum += sample * sample;
    const rms = Math.sqrt(squareSum / Math.max(1, output.length));
    const displayed = Math.min(1, rms * 4);
    this.elements.level.value = displayed;
    this.elements.levelLabel.value = `${Math.round(displayed * 100)}%`;
  }

  private stopGraph(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.mutedOutput?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.source = undefined;
    this.processor = undefined;
    this.mutedOutput = undefined;
    this.elements.level.value = 0;
    this.elements.levelLabel.value = '0%';
  }

  private download(): void {
    if (!this.recording?.format.valid) return;
    const anchor = document.createElement('a');
    anchor.href = this.recording.url;
    anchor.download = this.recording.fileName;
    anchor.click();
  }

  private renderIdle(): void {
    this.elements.prompt.textContent = '日本語録音または英語録音を選ぶと、読み上げ文を表示します。';
    this.elements.language.textContent = '未選択';
    this.elements.status.textContent = '録音待機';
    this.elements.validation.textContent = '未検証';
    this.elements.quality.textContent = '未測定';
    this.elements.player.hidden = true;
    this.renderDuration(0);
    this.renderControls(false);
  }

  private renderControls(recording: boolean): void {
    this.elements.jaButton.disabled = recording;
    this.elements.enButton.disabled = recording;
    this.elements.stopButton.disabled = !recording;
    this.elements.downloadButton.disabled = recording || !this.recording?.format.valid;
  }

  private renderResult(format: WavFormatInspection, quality: AudioQualityInspection): void {
    if (format.valid) {
      this.elements.validation.textContent = `合格: PCM signed 16-bit LE / ${format.sampleRate} Hz / mono / ${Math.round(format.durationMs ?? 0)} ms`;
      this.elements.validation.className = 'local-evaluation__result local-evaluation__result--ok';
    } else {
      this.elements.validation.textContent = `不合格: ${format.errors.join(' ')}`;
      this.elements.validation.className = 'local-evaluation__result local-evaluation__result--error';
    }
    const qualityNotes = [
      quality.silent ? '無音の可能性あり' : '音量あり',
      quality.clipped ? '音割れの可能性あり' : '顕著なクリッピングなし',
      `RMS ${(quality.rms * 100).toFixed(2)}%`,
      `peak ${(quality.peak * 100).toFixed(2)}%`,
    ];
    this.elements.quality.textContent = qualityNotes.join(' / ');
    this.elements.status.textContent = format.valid
      ? `${this.recording?.fileName ?? 'WAV'}を再生・ダウンロードできます。`
      : 'WAV形式が不正なため評価には使用できません。';
  }

  private renderDuration(milliseconds: number): void {
    const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
    const minutes = Math.floor(totalTenths / 600);
    const seconds = Math.floor(totalTenths / 10) % 60;
    this.elements.duration.value = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${totalTenths % 10}`;
  }

  private releaseRecording(): void {
    if (this.recording) URL.revokeObjectURL(this.recording.url);
    this.recording = undefined;
    this.elements.player.removeAttribute('src');
    this.elements.player.hidden = true;
    this.elements.downloadButton.disabled = true;
    this.elements.validation.textContent = '未検証';
    this.elements.validation.className = 'local-evaluation__result';
    this.elements.quality.textContent = '未測定';
  }
}

export function initializeLocalEvaluationRecorder(): LocalEvaluationRecorder {
  return new LocalEvaluationRecorder();
}

function concatenate(chunks: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'マイク利用が許可されていません。ブラウザーの権限設定を確認してください。';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') return '利用できるマイクが見つかりません。';
  return '評価用録音を開始できませんでした。';
}
