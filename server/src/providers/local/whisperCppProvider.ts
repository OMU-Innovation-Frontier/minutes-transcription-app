import { validateExistingFile, LocalProcessManager } from './localProcessManager.js';
import { LocalSttError, type LocalFileSpeechToTextProvider, type LocalFileTranscriptionInput, type LocalFileTranscriptionResult, type LocalModelDefinition } from './localSttTypes.js';

export interface WhisperCppProviderOptions {
  executablePath: string;
  modelPath: string;
  model: LocalModelDefinition;
  allowedBinaryRoots: readonly string[];
  allowedModelRoots: readonly string[];
  allowedAudioRoots: readonly string[];
  timeoutMs: number;
  threads?: number;
  useOpenVino?: boolean;
  openVinoDevice?: 'CPU' | 'GPU';
}

export class WhisperCppProvider implements LocalFileSpeechToTextProvider {
  readonly id;
  readonly model;

  constructor(
    private readonly options: WhisperCppProviderOptions,
    private readonly processes: LocalProcessManager,
  ) {
    this.id = options.model.provider;
    this.model = options.model;
    if (!options.model.whisperCppCompatible) {
      throw new LocalSttError('local_model_incompatible', 'The selected model is not compatible with whisper.cpp.');
    }
  }

  async transcribeFile(input: LocalFileTranscriptionInput): Promise<LocalFileTranscriptionResult> {
    const invocation = await this.describeFileInvocation(input);
    const result = await this.processes.run({
      executablePath: this.options.executablePath,
      allowedExecutableRoots: this.options.allowedBinaryRoots,
      timeoutMs: this.options.timeoutMs,
      arguments: invocation.arguments,
    });
    const transcript = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
    return {
      provider: this.id,
      model: this.model.id,
      language: input.language,
      transcript,
      totalProcessingMs: result.totalProcessingMs,
      // whisper-cli file mode emits the transcript as a final-only result. Its
      // first stdout byte is therefore not an interim-result latency.
      firstResultLatencyMs: undefined,
      finalLatencyMs: result.totalProcessingMs,
      processCpuAveragePercent: result.cpuAveragePercent,
      processCpuPeakPercent: result.cpuPeakPercent,
      peakWorkingSetBytes: result.peakMemoryBytes,
      logicalProcessorCount: result.logicalProcessorCount,
      executionArguments: invocation.arguments,
      threads: invocation.threads,
    };
  }

  async describeFileInvocation(input: LocalFileTranscriptionInput): Promise<{ arguments: readonly string[]; threads: number }> {
    if (!this.model.languages.includes(input.language)) {
      throw new LocalSttError('local_language_unsupported', 'The selected local model does not support this language.');
    }
    const modelPath = await validateExistingFile(
      this.options.modelPath,
      this.options.allowedModelRoots,
      'local_model_missing',
      'The selected local STT model is missing or outside the configured model directory.',
    );
    const audioPath = await validateExistingFile(
      input.audioPath,
      this.options.allowedAudioRoots,
      'local_audio_invalid',
      'The local audio file is missing or outside the configured input directory.',
    );
    const threads = this.options.threads ?? 4;
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) {
      throw new LocalSttError('local_threads_invalid', 'The local STT thread count is invalid.');
    }
    if (this.options.useOpenVino && !this.model.openVinoEncoderCompatible) {
      throw new LocalSttError('local_openvino_unsupported', 'OpenVINO is not registered for the selected model.');
    }
    const argumentsList = [
      '--model', modelPath,
      '--file', audioPath,
      '--language', input.language,
      '--threads', String(threads),
      '--no-timestamps',
      '--no-prints',
    ];
    if (this.options.useOpenVino) {
      argumentsList.push('--ov-e-device', this.options.openVinoDevice ?? 'CPU');
    } else {
      argumentsList.push('--no-gpu');
    }
    return { arguments: argumentsList, threads };
  }

  async close(): Promise<void> {
    await this.processes.close();
  }
}
