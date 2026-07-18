import type { AudioChunk } from '../audio/types';
import type {
  SpeechToTextCallbacks,
  SpeechToTextProvider,
  StartTranscriptionOptions,
  TranscriptionError,
  TranscriptionLanguage,
} from './types';

interface BrowserRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface BrowserRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserRecognitionAlternative;
}

interface BrowserRecognitionResultList {
  readonly length: number;
  readonly [index: number]: BrowserRecognitionResult;
}

interface BrowserRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserRecognitionResultList;
}

interface BrowserRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  onerror: ((event: BrowserRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserRecognitionConstructor = new () => BrowserRecognition;

export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'browser';
  readonly label = 'ブラウザ音声認識';
  readonly isMock = false;

  private recognition: BrowserRecognition | null = null;
  private callbacks: SpeechToTextCallbacks = {};
  private sessionId = '';
  private language: TranscriptionLanguage = 'ja-JP';
  private sequence = 0;
  private runId = 0;
  private active = false;
  private stopRequested = false;
  private readonly revisions = new Map<string, number>();
  private readonly segmentStartTimes = new Map<string, number>();
  private startResolve: (() => void) | null = null;
  private startReject: ((reason: TranscriptionError) => void) | null = null;
  private stopResolve: (() => void) | null = null;
  private restartTimer: number | undefined;
  private startTimer: number | undefined;
  private stopTimer: number | undefined;

  isSupported(): boolean {
    return getRecognitionConstructor() !== undefined;
  }

  start(options: StartTranscriptionOptions): Promise<void> {
    const Recognition = getRecognitionConstructor();
    if (!Recognition) {
      const error: TranscriptionError = {
        code: 'unsupported',
        message: 'このブラウザは音声認識に対応していません。モック認識を選択してください。',
      };
      options.callbacks?.onError?.(error);
      return Promise.reject(error);
    }

    this.callbacks = options.callbacks ?? {};
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.sequence = 0;
    this.runId = 0;
    this.revisions.clear();
    this.segmentStartTimes.clear();
    this.active = true;
    this.stopRequested = false;
    this.recognition = new Recognition();
    this.configureRecognition(this.recognition);
    this.callbacks.onStateChange?.('connecting');

    return new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.startTimer = window.setTimeout(() => {
        this.fail({
          code: 'network',
          message: '音声認識サービスへの接続がタイムアウトしました。ネットワークを確認するか、モック認識をお試しください。',
        });
      }, 8_000);
      this.startRecognition();
    });
  }

  // The browser provider consumes a native microphone stream internally.
  // Keeping this method allows chunk/WebSocket providers to use the same contract.
  acceptChunk(chunk: AudioChunk): void {
    void chunk;
  }

  stop(): Promise<void> {
    if (!this.recognition || !this.active) {
      this.recognition = null;
      this.callbacks.onStateChange?.('disconnected');
      return Promise.resolve();
    }
    this.stopRequested = true;
    this.callbacks.onStateChange?.('degraded');
    window.clearTimeout(this.restartTimer);

    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      this.stopTimer = window.setTimeout(() => this.finishStop(), 3_000);
      try {
        this.recognition?.stop();
      } catch {
        this.finishStop();
      }
    });
  }

  async abort(): Promise<void> {
    this.stopRequested = true;
    this.active = false;
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.startTimer);
    window.clearTimeout(this.stopTimer);
    try {
      this.recognition?.abort();
    } catch {
      // The recognition service may already be disconnected.
    }
    this.recognition = null;
    this.resolvePendingStart({
      code: 'service',
      message: '音声認識を中止しました。',
    });
    this.finishStop();
  }

  private configureRecognition(recognition: BrowserRecognition): void {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = this.language;
    recognition.onstart = () => {
      window.clearTimeout(this.startTimer);
      this.callbacks.onStateChange?.('transcribing');
      this.startResolve?.();
      this.startResolve = null;
      this.startReject = null;
    };
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => this.handleEnd();
  }

  private startRecognition(): void {
    if (!this.active || this.stopRequested || !this.recognition) return;
    try {
      this.recognition.start();
    } catch (cause) {
      this.fail({
        code: 'service',
        message: '音声認識サービスを開始できませんでした。少し待ってから再試行してください。',
        cause,
      });
    }
  }

  private handleResult(event: BrowserRecognitionEvent): void {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result?.[0];
      if (!result || !alternative?.transcript.trim()) continue;

      const segmentId = `browser-${this.runId}-${index}`;
      const now = Date.now();
      const startTime = this.segmentStartTimes.get(segmentId) ?? now;
      this.segmentStartTimes.set(segmentId, startTime);
      const revision = (this.revisions.get(segmentId) ?? -1) + 1;
      this.revisions.set(segmentId, revision);
      this.callbacks.onTranscript?.({
        sessionId: this.sessionId,
        segmentId,
        sequence: this.sequence++,
        revision,
        text: alternative.transcript,
        isFinal: result.isFinal,
        language: this.language,
        provider: this.id,
        startTime,
        endTime: result.isFinal ? now : undefined,
        confidence: result.isFinal ? alternative.confidence : undefined,
        createdAt: new Date(now).toISOString(),
      });
      if (result.isFinal) this.segmentStartTimes.delete(segmentId);
    }
  }

  private handleError(event: BrowserRecognitionErrorEvent): void {
    if ((event.error === 'aborted' && this.stopRequested) || event.error === 'no-speech') return;
    this.fail(toTranscriptionError(event.error));
  }

  private handleEnd(): void {
    if (this.stopRequested) {
      this.finishStop();
      return;
    }
    if (!this.active) return;

    this.runId += 1;
    this.callbacks.onStateChange?.('connecting');
    this.restartTimer = window.setTimeout(() => this.startRecognition(), 250);
  }

  private fail(error: TranscriptionError): void {
    this.active = false;
    window.clearTimeout(this.startTimer);
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.stopTimer);
    this.callbacks.onStateChange?.('error');
    this.callbacks.onError?.(error);
    this.resolvePendingStart(error);
    this.stopResolve?.();
    this.stopResolve = null;
  }

  private resolvePendingStart(error: TranscriptionError): void {
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
  }

  private finishStop(): void {
    this.active = false;
    window.clearTimeout(this.startTimer);
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.stopTimer);
    this.recognition = null;
    this.callbacks.onStateChange?.('disconnected');
    this.stopResolve?.();
    this.stopResolve = null;
  }
}

export function isBrowserSpeechRecognitionSupported(): boolean {
  return getRecognitionConstructor() !== undefined;
}

function getRecognitionConstructor(): BrowserRecognitionConstructor | undefined {
  const speechWindow = window as unknown as {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function toTranscriptionError(errorCode: string): TranscriptionError {
  switch (errorCode) {
    case 'not-allowed':
    case 'service-not-allowed':
      return {
        code: 'permission-denied',
        message: '音声認識でマイクを使用できません。ブラウザのマイク権限を確認してください。',
      };
    case 'network':
      return {
        code: 'network',
        message: '音声認識サービスへ接続できません。ネットワーク接続を確認してください。',
      };
    default:
      return {
        code: 'service',
        message: '音声認識サービスでエラーが発生しました。モック認識への切り替えも利用できます。',
      };
  }
}
