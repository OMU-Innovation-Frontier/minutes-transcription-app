import './styles.css';
import type { LiveMeetingSummary, MeetingUsageSummary } from '../shared/summary';
import type { CorrectionServiceStatus } from '../shared/correction';
import { AudioCapture } from './audio/audioCapture';
import type { AudioChunkSink, CaptureState, MicrophoneError } from './audio/types';
import { CorrectionCoordinator, CorrectionHttpClient } from './correction/correctionClient';
import { correctionStatusPresentation } from './correction/transcriptPresentation';
import { initializeLocalEvaluationRecorder } from './localRecording/localEvaluationRecorder';
import { IncrementalSummaryCoordinator, SummaryHttpClient, type SummaryStatus } from './summary/summaryClient';
import { isBrowserSpeechRecognitionSupported } from './transcription/browserProvider';
import { connectionPresentation } from './transcription/connectionPresentation';
import { createSpeechToTextProvider, getDefaultProviderKind } from './transcription/providerFactory';
import { TranscriptStore } from './transcription/transcriptStore';
import type {
  SpeechToTextProvider,
  SpeechToTextProviderKind,
  TranscriptionError,
  TranscriptionLanguage,
  TranscriptionState,
} from './transcription/types';
import {
  applyAppView,
  createInitialAppViewState,
  transitionAppView,
  type AppViewState,
} from './ui/appView';
import { presentLiveSummary } from './ui/liveSummaryView';
import { followStateAfterScroll, shouldFollowTranscriptUpdate } from './ui/scrollFollow';
import { createRawSegmentElement, createSentenceElement } from './ui/transcriptView';
import { buildMeetingSetupSummary, createInitialMeetingSetupDraft, createMeetingSettingsSnapshot, meetingTranscriptionCatalog, type MeetingSettingsSnapshot, type MeetingSetupDraft } from './meetingSetup/meetingSetup';
import { renderMeetingSettingsSummary } from './meetingSetup/meetingSettingsSummary';
import {
  FinalMeetingSummaryController,
  renderFinalMeetingSummary,
  type CompleteFinalMeetingSummaryOptions,
} from './summary/finalMeetingSummary';

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} was not found.`);
  return element as T;
}

const elements = {
  homeView: requiredElement<HTMLElement>('home-view'),
  meetingSetupView: requiredElement<HTMLElement>('meeting-setup-view'),
  meetingView: requiredElement<HTMLElement>('meeting-view'),
  meetingDetailView: requiredElement<HTMLElement>('meeting-detail-view'),
  newMeetingButton: requiredElement<HTMLButtonElement>('new-meeting-button'),
  setupForm: requiredElement<HTMLFormElement>('meeting-setup-form'),
  setupCancelButton: requiredElement<HTMLButtonElement>('setup-cancel-button'),
  setupCancelSecondary: requiredElement<HTMLButtonElement>('setup-cancel-button-secondary'),
  setupTitle: requiredElement<HTMLInputElement>('setup-title'),
  setupLanguage: requiredElement<HTMLSelectElement>('setup-language'),
  setupProvider: requiredElement<HTMLSelectElement>('setup-provider'),
  setupProviderDescription: requiredElement<HTMLElement>('setup-provider-description'),
  setupCorrection: requiredElement<HTMLInputElement>('setup-correction'),
  setupLiveSummary: requiredElement<HTMLInputElement>('setup-live-summary'),
  setupFinalSummary: requiredElement<HTMLInputElement>('setup-final-summary'),
  setupExternalConfirmation: requiredElement<HTMLElement>('setup-external-confirmation'),
  setupExternalAck: requiredElement<HTMLInputElement>('setup-external-ack'),
  setupSummaryList: requiredElement<HTMLUListElement>('setup-summary-list'),
  setupCreateButton: requiredElement<HTMLButtonElement>('setup-create-button'),
  resumeMeetingButton: requiredElement<HTMLButtonElement>('resume-meeting-button'),
  homeActiveMeeting: requiredElement<HTMLElement>('home-active-meeting'),
  homeHistoryEmpty: requiredElement<HTMLElement>('home-history-empty'),
  meetingHistoryList: requiredElement<HTMLOListElement>('meeting-history-list'),
  homeConnectionError: requiredElement<HTMLElement>('home-connection-error'),
  meetingHomeButton: requiredElement<HTMLButtonElement>('meeting-home-button'),
  detailHomeButton: requiredElement<HTMLButtonElement>('detail-home-button'),
  homeSettingsButton: requiredElement<HTMLButtonElement>('home-settings-button'),
  meetingSettingsButton: requiredElement<HTMLButtonElement>('meeting-settings-button'),
  settingsPanel: requiredElement<HTMLElement>('settings-panel'),
  settingsCloseButton: requiredElement<HTMLButtonElement>('settings-close-button'),
  meetingSettingsSummary: requiredElement<HTMLElement>('meeting-settings-summary'),
  meetingTitle: requiredElement<HTMLElement>('meeting-title'),
  meetingTitleInput: requiredElement<HTMLInputElement>('meeting-title-input'),
  endMeetingButton: requiredElement<HTMLButtonElement>('end-meeting-button'),
  endMeetingButtonFooter: requiredElement<HTMLButtonElement>('end-meeting-button-footer'),
  endMeetingDialog: requiredElement<HTMLElement>('end-meeting-dialog'),
  cancelEndMeetingButton: requiredElement<HTMLButtonElement>('cancel-end-meeting-button'),
  confirmEndMeetingButton: requiredElement<HTMLButtonElement>('confirm-end-meeting-button'),
  detailTitle: requiredElement<HTMLElement>('detail-title'),
  detailDate: requiredElement<HTMLElement>('detail-date'),
  detailSummaryText: requiredElement<HTMLElement>('detail-summary-text'),
  detailTranscript: requiredElement<HTMLOListElement>('detail-transcript'),
  detailTranscriptEmpty: requiredElement<HTMLElement>('detail-transcript-empty'),
  startButton: requiredElement<HTMLButtonElement>('start-button'),
  stopButton: requiredElement<HTMLButtonElement>('stop-button'),
  reconnectButton: requiredElement<HTMLButtonElement>('reconnect-button'),
  recordingStatus: requiredElement<HTMLElement>('recording-status'),
  recordingStatusLabel: requiredElement<HTMLElement>('recording-status-label'),
  recognitionStatus: requiredElement<HTMLElement>('recognition-status'),
  recognitionStatusLabel: requiredElement<HTMLElement>('recognition-status-label'),
  microphoneState: requiredElement<HTMLElement>('microphone-state'),
  providerSelect: requiredElement<HTMLSelectElement>('provider-select'),
  languageSelect: requiredElement<HTMLSelectElement>('language-select'),
  providerLabel: requiredElement<HTMLElement>('provider-label'),
  levelBar: requiredElement<HTMLElement>('level-bar'),
  levelMeter: requiredElement<HTMLElement>('level-meter'),
  levelLabel: requiredElement<HTMLOutputElement>('level-label'),
  elapsedTime: requiredElement<HTMLElement>('elapsed-time'),
  elapsedTimeFooter: requiredElement<HTMLElement>('elapsed-time-footer'),
  chunkCount: requiredElement<HTMLElement>('chunk-count'),
  bufferedAudio: requiredElement<HTMLElement>('buffered-audio'),
  reconnectAttempt: requiredElement<HTMLElement>('reconnect-attempt'),
  connectionNote: requiredElement<HTMLElement>('connection-note'),
  bufferWarning: requiredElement<HTMLElement>('buffer-warning'),
  error: requiredElement<HTMLElement>('error-message'),
  clearTranscriptButton: requiredElement<HTMLButtonElement>('clear-transcript-button'),
  finalizeSentenceButton: requiredElement<HTMLButtonElement>('finalize-sentence-button'),
  transcriptView: requiredElement<HTMLSelectElement>('transcript-view'),
  transcriptScroll: requiredElement<HTMLElement>('transcript-scroll'),
  finalTranscript: requiredElement<HTMLOListElement>('final-transcript'),
  interimTranscript: requiredElement<HTMLElement>('interim-transcript'),
  interimText: requiredElement<HTMLElement>('interim-text'),
  transcriptEmpty: requiredElement<HTMLElement>('transcript-empty'),
  latestTranscriptButton: requiredElement<HTMLButtonElement>('latest-transcript-button'),
  latestAnnouncement: requiredElement<HTMLElement>('latest-announcement'),
  correctionStatus: requiredElement<HTMLElement>('correction-status'),
  correctionPrivacy: requiredElement<HTMLElement>('correction-privacy'),
  correctionWarning: requiredElement<HTMLElement>('correction-warning'),
  privacyNote: requiredElement<HTMLElement>('privacy-note'),
  localWhisperStats: requiredElement<HTMLElement>('local-whisper-stats'),
  localWhisperModel: requiredElement<HTMLElement>('local-whisper-model'),
  localWhisperLanguage: requiredElement<HTMLElement>('local-whisper-language'),
  localWhisperQueue: requiredElement<HTMLElement>('local-whisper-queue'),
  localWhisperAudioDuration: requiredElement<HTMLElement>('local-whisper-audio-duration'),
  localWhisperProcessingTime: requiredElement<HTMLElement>('local-whisper-processing-time'),
  localWhisperRtf: requiredElement<HTMLElement>('local-whisper-rtf'),
  summaryProviderStatus: requiredElement<HTMLElement>('summary-provider-status'),
  summaryWarning: requiredElement<HTMLElement>('summary-warning'),
  summaryEmpty: requiredElement<HTMLElement>('summary-empty'),
  summaryContent: requiredElement<HTMLElement>('summary-content'),
  summaryTopic: requiredElement<HTMLElement>('summary-topic'),
  summaryPoints: requiredElement<HTMLUListElement>('summary-points'),
  summaryDecisions: requiredElement<HTMLUListElement>('summary-decisions'),
  summaryActions: requiredElement<HTMLUListElement>('summary-actions'),
  summaryQuestions: requiredElement<HTMLUListElement>('summary-questions'),
  usageInput: requiredElement<HTMLElement>('usage-input'),
  usageOutput: requiredElement<HTMLElement>('usage-output'),
  usageCost: requiredElement<HTMLElement>('usage-cost'),
  finalSummary: requiredElement<HTMLElement>('final-summary'),
};

let provider: SpeechToTextProvider = createSpeechToTextProvider(getDefaultProviderKind());
let captureState: CaptureState = 'idle';
let transcriptionState: TranscriptionState = 'disconnected';
let appState: AppViewState = createInitialAppViewState();
let chunksReceived = 0;
let elapsedTimer: number | undefined;
let sessionTransition = false;
let currentSessionId = '';
let currentMeetingId = '';
let meetingStartedAt: number | null = null;
let meetingEndedAt: number | null = null;
let meetingHasRecorded = false;
let meetingSettingsSnapshot: MeetingSettingsSnapshot | null = null;
let meetingSetupDraft: MeetingSetupDraft = createInitialMeetingSetupDraft();
let reconnectAttempt = 0;
let reconnectMaxAttempts = 0;
let summaryCoordinator: IncrementalSummaryCoordinator | null = null;
let correctionCoordinator: CorrectionCoordinator | null = null;
const correctionCoordinators: CorrectionCoordinator[] = [];
let latestLiveSummary: LiveMeetingSummary | null = null;
let latestSummaryStatus: SummaryStatus | null = null;
let autoFollowTranscript = true;
let renderedSentenceCount = 0;
let renderedInterimText = '';

const summaryClient = new SummaryHttpClient();
const correctionClient = new CorrectionHttpClient();
const transcriptStore = new TranscriptStore({ onChange: handleTranscriptChange });
const localEvaluationRecorder = initializeLocalEvaluationRecorder();
const finalSummaryController = new FinalMeetingSummaryController(() => renderDetailView());

const recognitionOption = elements.providerSelect.querySelector<HTMLOptionElement>('option[value="browser"]');
if (recognitionOption && !isBrowserSpeechRecognitionSupported()) {
  recognitionOption.disabled = true;
  recognitionOption.textContent = 'ブラウザー音声認識（この環境では利用不可）';
}
elements.providerSelect.value = provider.id;

const transcriptionSink: AudioChunkSink = {
  async handle(chunk): Promise<void> {
    chunksReceived += 1;
    elements.chunkCount.textContent = String(chunksReceived);
    await provider.acceptChunk(chunk);
  },
};

const capture = new AudioCapture(transcriptionSink, {
  onStateChange: renderCaptureState,
  onLevel: renderLevel,
  onError: handleCaptureError,
  onSinkError: (error) => renderBufferWarning(getErrorMessage(error)),
});

elements.newMeetingButton.addEventListener('click', beginMeeting);
elements.setupCancelButton.addEventListener('click', cancelMeetingSetup);
elements.setupCancelSecondary.addEventListener('click', cancelMeetingSetup);
elements.setupForm.addEventListener('submit', (event) => { event.preventDefault(); createMeetingFromSetup(); });
for (const input of [elements.setupTitle, elements.setupLanguage, elements.setupProvider, elements.setupCorrection, elements.setupLiveSummary, elements.setupFinalSummary, elements.setupExternalAck]) input.addEventListener('input', renderMeetingSetup);
elements.resumeMeetingButton.addEventListener('click', () => setAppState(transitionAppView(appState, 'resume-meeting')));
elements.meetingHomeButton.addEventListener('click', () => setAppState(transitionAppView(appState, 'open-home')));
elements.detailHomeButton.addEventListener('click', () => setAppState(transitionAppView(appState, 'open-home')));
elements.homeSettingsButton.addEventListener('click', openSettings);
elements.meetingSettingsButton.addEventListener('click', openSettings);
elements.settingsCloseButton.addEventListener('click', closeSettings);
elements.meetingTitleInput.addEventListener('input', updateMeetingTitle);
elements.startButton.addEventListener('click', () => void startSession());
elements.stopButton.addEventListener('click', () => void pauseSession());
elements.reconnectButton.addEventListener('click', () => provider.reconnect?.());
elements.endMeetingButton.addEventListener('click', openEndMeetingDialog);
elements.endMeetingButtonFooter.addEventListener('click', openEndMeetingDialog);
elements.cancelEndMeetingButton.addEventListener('click', closeEndMeetingDialog);
elements.confirmEndMeetingButton.addEventListener('click', () => void finishMeeting());
elements.latestTranscriptButton.addEventListener('click', scrollToLatestTranscript);
elements.transcriptScroll.addEventListener('scroll', handleTranscriptScroll, { passive: true });
elements.finalizeSentenceButton.addEventListener('click', () => {
  if (transcriptStore.finalizeSentenceManually()) handleTranscriptChange();
});
elements.clearTranscriptButton.addEventListener('click', () => {
  transcriptStore.clear();
  renderTranscript();
});
elements.transcriptView.addEventListener('change', renderTranscript);
elements.providerSelect.addEventListener('change', renderProviderDetails);
elements.languageSelect.addEventListener('change', renderProviderDetails);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!elements.endMeetingDialog.hidden) closeEndMeetingDialog();
  else if (!elements.settingsPanel.hidden) closeSettings();
});
window.addEventListener('pagehide', () => {
  window.clearInterval(elapsedTimer);
  summaryCoordinator?.dispose();
  for (const coordinator of correctionCoordinators) coordinator.dispose();
  localEvaluationRecorder.dispose();
  void capture.stop();
  void provider.abort();
});

function beginMeeting(): void {
  if (appState.meetingStarted && !appState.meetingEnded) {
    setAppState(transitionAppView(appState, 'resume-meeting'));
    return;
  }
  if (appState.meetingEnded) resetMeetingData();
  meetingSetupDraft = createInitialMeetingSetupDraft(getDefaultProviderKind());
  renderMeetingSetup();
  setAppState(transitionAppView(appState, 'open-meeting-setup'));
}

function cancelMeetingSetup(): void {
  meetingSetupDraft = createInitialMeetingSetupDraft(getDefaultProviderKind());
  setAppState(transitionAppView(appState, 'cancel-meeting-setup'));
}

function renderMeetingSetup(): void {
  meetingSetupDraft = { title: elements.setupTitle.value, language: elements.setupLanguage.value as MeetingSetupDraft['language'], transcriptionProvider: elements.setupProvider.value as MeetingSetupDraft['transcriptionProvider'], correctionEnabled: elements.setupCorrection.checked, liveSummaryEnabled: elements.setupLiveSummary.checked, finalSummaryEnabled: elements.setupFinalSummary.checked, historyRetention: 'page-session', externalProcessingAcknowledged: elements.setupExternalAck.checked };
  const option = meetingTranscriptionCatalog.find((item) => item.id === meetingSetupDraft.transcriptionProvider);
  elements.setupProviderDescription.textContent = option?.description ?? '';
  elements.setupExternalConfirmation.hidden = !option?.externalAcknowledgementRequired;
  elements.setupCreateButton.disabled = Boolean(option?.externalAcknowledgementRequired && !meetingSetupDraft.externalProcessingAcknowledged);
  elements.setupSummaryList.replaceChildren(...buildMeetingSetupSummary(meetingSetupDraft).map((text) => { const li = document.createElement('li'); li.textContent = text; return li; }));
}

function createMeetingFromSetup(): void {
  try { meetingSettingsSnapshot = createMeetingSettingsSnapshot(meetingSetupDraft, new Date().toISOString()); }
  catch { elements.setupTitle.focus(); return; }
  resetMeetingData();
  currentMeetingId = createSessionId();
  meetingStartedAt = null;
  meetingEndedAt = null;
  elements.meetingTitle.textContent = meetingSettingsSnapshot.title;
  elements.meetingTitleInput.value = meetingSettingsSnapshot.title;
  renderMeetingSettingsSummary(elements.meetingSettingsSummary, meetingSettingsSnapshot);
  setAppState(transitionAppView(appState, 'create-meeting'));
}

function resetMeetingData(): void {
  summaryCoordinator?.dispose();
  summaryCoordinator = null;
  for (const coordinator of correctionCoordinators.splice(0)) coordinator.dispose();
  correctionCoordinator = null;
  transcriptStore.clear();
  currentSessionId = '';
  latestLiveSummary = null;
  latestSummaryStatus = null;
  finalSummaryController.reset();
  meetingHasRecorded = false;
  renderedSentenceCount = 0;
  renderedInterimText = '';
  autoFollowTranscript = true;
  chunksReceived = 0;
  reconnectAttempt = 0;
  reconnectMaxAttempts = 0;
  resetSummaryView();
  renderTranscript();
  renderUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true });
}

async function startSession(): Promise<void> {
  if (sessionTransition || captureState !== 'idle' || appState.meetingEnded) return;
  if (!appState.meetingStarted || !meetingSettingsSnapshot) return;
  meetingStartedAt ??= Date.now();
  startElapsedTimer();
  setAppState({ ...appState, view: 'meeting' });
  sessionTransition = true;
  hideError();
  hideBufferWarning();
  chunksReceived = 0;
  reconnectAttempt = 0;
  reconnectMaxAttempts = 0;
  elements.chunkCount.textContent = '0';
  elements.reconnectAttempt.textContent = '—';

  currentSessionId = createSessionId();
  transcriptStore.startSession(currentSessionId);
  if (meetingSettingsSnapshot.correctionEnabled) {
    correctionCoordinator = createCorrectionCoordinator(currentSessionId);
    correctionCoordinators.push(correctionCoordinator);
    correctionCoordinator.add(transcriptStore.snapshot().completedSentences);
    void correctionCoordinator.initialize();
  }
  if (!summaryCoordinator && (meetingSettingsSnapshot.liveSummaryEnabled || meetingSettingsSnapshot.finalSummaryEnabled)) {
    summaryCoordinator = createSummaryCoordinator(currentMeetingId || currentSessionId);
    void summaryCoordinator.initialize();
  }

  provider = createSpeechToTextProvider(meetingSettingsSnapshot.transcriptionProvider);
  renderProviderDetails();
  renderControls();
  try {
    await capture.start(provider.audioCaptureMode);
  } catch (error) {
    renderError(error);
    await provider.abort();
    sessionTransition = false;
    renderControls();
    return;
  }

  const startPromise = provider.start({
    sessionId: currentSessionId,
    language: meetingSettingsSnapshot.language as TranscriptionLanguage,
    audioFormat: capture.currentMimeType,
    callbacks: {
      onStateChange: renderTranscriptionState,
      onReconnectAttempt: (attempt, maxAttempts) => {
        reconnectAttempt = attempt;
        reconnectMaxAttempts = maxAttempts;
        elements.reconnectAttempt.textContent = attempt > 0 ? `${attempt} / ${maxAttempts}` : '—';
        renderConnectionNote();
      },
      onTranscript: (update) => {
        if (transcriptStore.apply(update)) handleTranscriptChange();
      },
      onError: handleProviderError,
      onWarning: handleProviderWarning,
      onBufferedAudioChange: (snapshot) => {
        elements.bufferedAudio.textContent = `${Math.ceil(snapshot.durationSeconds)}秒`;
        if (snapshot.limitReached) renderBufferWarning('未送信音声が上限に達しました。接続状態を確認してください。');
      },
      onProviderStatus: (status) => {
        elements.localWhisperQueue.textContent = String(status.queueLength);
        elements.localWhisperModel.textContent = status.model ?? 'whisper-small-q5_1';
        elements.localWhisperLanguage.textContent = status.language === 'ja' ? '日本語' : 'English';
        if (status.audioDurationMs !== undefined) elements.localWhisperAudioDuration.textContent = `${(status.audioDurationMs / 1_000).toFixed(2)}秒`;
        if (status.processingTimeMs !== undefined) elements.localWhisperProcessingTime.textContent = `${(status.processingTimeMs / 1_000).toFixed(2)}秒`;
        if (status.realTimeFactor !== undefined) elements.localWhisperRtf.textContent = status.realTimeFactor.toFixed(3);
      },
    },
  });
  void startPromise.catch(handleProviderError);
  meetingHasRecorded = true;
  sessionTransition = false;
  renderControls();
}

async function pauseSession(): Promise<void> {
  if (sessionTransition || captureState === 'idle') return;
  sessionTransition = true;
  renderControls();
  let firstError: unknown;
  try {
    await capture.stop();
  } catch (error) {
    firstError = error;
  }
  try {
    await provider.stop();
  } catch (error) {
    firstError ??= error;
  }
  transcriptStore.finalizeRecording();
  handleTranscriptChange();
  await summaryCoordinator?.flushLive();
  if (firstError) renderError(firstError);
  sessionTransition = false;
  renderControls();
}

async function finishMeeting(): Promise<void> {
  if (sessionTransition || !appState.meetingStarted || appState.meetingEnded) return;
  closeEndMeetingDialog();
  if (captureState !== 'idle') await pauseSession();
  sessionTransition = true;
  renderControls();
  meetingEndedAt = Date.now();
  window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  appState = transitionAppView(appState, 'end-meeting');
  setAppState(appState);
  const settings = meetingSettingsSnapshot;
  if (settings?.finalSummaryEnabled && !summaryCoordinator) {
    summaryCoordinator = createSummaryCoordinator(currentMeetingId);
  }
  await finalSummaryController.complete(createFinalSummaryOptions());
  sessionTransition = false;
  renderDetailView();
}

function createFinalSummaryOptions(): CompleteFinalMeetingSummaryOptions {
  const settings = meetingSettingsSnapshot;
  return {
    meetingId: currentMeetingId,
    settings,
    sentences: transcriptStore.snapshot().completedSentences,
    provider: () => latestSummaryStatus?.provider ?? null,
    finalize: async (sentences) => {
      if (!summaryCoordinator) return null;
      if (settings?.liveSummaryEnabled) await summaryCoordinator.flushLive();
      return summaryCoordinator.finalize(sentences);
    },
  };
}

async function retryFinalMeetingSummary(): Promise<void> {
  if (!appState.meetingStarted || !appState.meetingEnded) return;
  const options = createFinalSummaryOptions();
  if (!finalSummaryController.retryAvailability(options).available) {
    renderDetailView();
    return;
  }
  await finalSummaryController.retry(options);
}

function createSummaryCoordinator(meetingId: string): IncrementalSummaryCoordinator {
  return new IncrementalSummaryCoordinator(summaryClient, meetingId, envNumber('VITE_SUMMARY_SENTENCE_BATCH_SIZE', 3), {
    onStatus: renderSummaryStatus,
    onLiveSummary: renderLiveSummary,
    onUsage: renderUsage,
    onError: (error) => renderSummaryWarning(error.message),
  });
}

function createCorrectionCoordinator(sessionId: string): CorrectionCoordinator {
  return new CorrectionCoordinator(correctionClient, transcriptStore, sessionId, {
    onStatus: renderCorrectionStatus,
    onError: (error) => renderCorrectionWarning(error.message),
  }, { meetingId: currentMeetingId || sessionId });
}

function handleTranscriptChange(): void {
  const snapshot = transcriptStore.snapshot();
  renderTranscript();
  correctionCoordinator?.add(snapshot.completedSentences);
  if (meetingSettingsSnapshot?.liveSummaryEnabled) summaryCoordinator?.add(snapshot.completedSentences);
}

function renderCaptureState(state: CaptureState): void {
  captureState = state;
  elements.recordingStatus.classList.toggle('meeting-state--recording', state === 'recording');
  elements.recordingStatus.classList.toggle('meeting-state--error', state === 'error');
  const labels: Record<CaptureState, string> = {
    idle: meetingHasRecorded ? '一時停止中' : '会議開始前',
    starting: 'マイク権限を確認中',
    recording: '録音中',
    stopping: '一時停止しています',
    error: 'マイクエラー',
  };
  elements.recordingStatusLabel.textContent = labels[state];
  elements.microphoneState.textContent = state === 'recording' ? 'マイク入力中' : labels[state];
  renderConnectionNote();
  renderControls();
  renderHomeState();
}

function renderTranscriptionState(state: TranscriptionState): void {
  transcriptionState = state;
  const presentation = connectionPresentation(state);
  elements.recognitionStatus.classList.toggle('connection-status--listening', presentation.listening);
  elements.recognitionStatus.classList.toggle('connection-status--error', presentation.terminalError);
  elements.recognitionStatusLabel.textContent = presentation.label;
  if (presentation.clearRecoveredMessages) {
    hideError();
    hideBufferWarning();
  }
  renderConnectionNote();
  renderControls();
}

function renderConnectionNote(): void {
  if (captureState !== 'recording') {
    elements.connectionNote.hidden = true;
    return;
  }
  const attempts = reconnectAttempt > 0 ? ` 再接続 ${reconnectAttempt}/${reconnectMaxAttempts}` : '';
  const messages: Partial<Record<TranscriptionState, string>> = {
    reconnecting: `接続を回復しています。録音は続いています。${attempts}`,
    resuming: '同じ録音セッションへ再接続しています。',
    replaying: '接続中に保持した音声を順番に送っています。',
    degraded: '接続が不安定です。録音は続いています。',
  };
  const message = messages[transcriptionState];
  elements.connectionNote.hidden = !message;
  elements.connectionNote.textContent = message ?? '';
}

function renderControls(): void {
  const active = captureState !== 'idle';
  elements.startButton.disabled = active || sessionTransition || appState.meetingEnded;
  elements.startButton.textContent = meetingHasRecorded ? '録音を再開' : '録音を開始';
  elements.stopButton.disabled = !active || sessionTransition;
  elements.endMeetingButton.disabled = sessionTransition || appState.meetingEnded;
  elements.endMeetingButtonFooter.disabled = sessionTransition || appState.meetingEnded;
  elements.reconnectButton.disabled = !active || !provider.reconnect
    || !(transcriptionState === 'reconnecting' || transcriptionState === 'degraded' || transcriptionState === 'error');
  elements.providerSelect.disabled = active || sessionTransition;
  elements.languageSelect.disabled = active || sessionTransition;
  elements.finalizeSentenceButton.disabled = !active;
}

function renderProviderDetails(): void {
  const selected = createSpeechToTextProvider(elements.providerSelect.value as SpeechToTextProviderKind);
  elements.providerLabel.textContent = selected.label;
  elements.localWhisperStats.hidden = selected.id !== 'local-whisper';
  elements.localWhisperLanguage.textContent = elements.languageSelect.value === 'ja-JP' ? '日本語' : 'English';
  elements.privacyNote.textContent = selected.id === 'local-whisper'
    ? '音声はこのPCのローカルサーバーへ送り、Whisper smallで処理します。外部STT APIへは送信しません。'
    : selected.id === 'websocket'
      ? '音声は設定済みのバックエンドへ送信します。接続中の音声は一時的にIndexedDBへ保持します。'
      : selected.isMock
        ? 'モック認識では音声を保存せず、外部へ送信しません。'
        : 'ブラウザーの音声認識ポリシーとマイク権限を確認してください。';
}

function renderTranscript(): void {
  const snapshot = transcriptStore.snapshot();
  const showRaw = elements.transcriptView.value === 'raw';
  const nextCount = snapshot.completedSentences.length;
  const interimChanged = snapshot.interimDisplayText !== renderedInterimText;
  const shouldFollow = shouldFollowTranscriptUpdate(autoFollowTranscript, renderedSentenceCount, nextCount, interimChanged);
  const previousScrollTop = elements.transcriptScroll.scrollTop;
  const enteringSentenceId = nextCount > renderedSentenceCount ? snapshot.completedSentences.at(-1)?.id : undefined;

  const mainItems = showRaw
    ? snapshot.rawSegments.map((segment, index) => createRawSegmentElement(segment, index, snapshot.rawSegments.length))
    : snapshot.completedSentences.map((sentence, index) => createSentenceElement(sentence, index, nextCount, {
      enteringSentenceId,
      onRetryCorrection: retryCorrection,
    }));
  elements.finalTranscript.replaceChildren(...mainItems);

  const detailItems = snapshot.completedSentences.map((sentence, index) => createSentenceElement(sentence, index, nextCount, {
    onRetryCorrection: retryCorrection,
  }));
  elements.detailTranscript.replaceChildren(...detailItems);
  elements.detailTranscriptEmpty.hidden = detailItems.length > 0;
  elements.interimTranscript.hidden = !snapshot.interimDisplayText;
  elements.interimText.textContent = snapshot.interimDisplayText;
  elements.transcriptEmpty.hidden = mainItems.length > 0 || Boolean(snapshot.interimDisplayText);
  elements.clearTranscriptButton.disabled = mainItems.length === 0 && !snapshot.interimDisplayText;

  if (enteringSentenceId) {
    const latest = snapshot.completedSentences.at(-1);
    if (latest) elements.latestAnnouncement.textContent = `新しい発言: ${latest.correction?.status === 'completed' ? latest.correction.correctedText : latest.rawText}`;
  }
  renderedSentenceCount = nextCount;
  renderedInterimText = snapshot.interimDisplayText;
  elements.latestTranscriptButton.hidden = autoFollowTranscript;

  window.requestAnimationFrame(() => {
    if (shouldFollow) scrollToLatestTranscript();
    else if (!autoFollowTranscript) elements.transcriptScroll.scrollTop = previousScrollTop;
  });
}

function retryCorrection(sentenceId: string): void {
  if (!correctionCoordinator?.retry(sentenceId)) {
    renderCorrectionWarning('この発話は現在再試行できません。');
  }
}

function handleTranscriptScroll(): void {
  autoFollowTranscript = followStateAfterScroll({
    scrollTop: elements.transcriptScroll.scrollTop,
    scrollHeight: elements.transcriptScroll.scrollHeight,
    clientHeight: elements.transcriptScroll.clientHeight,
  });
  elements.latestTranscriptButton.hidden = autoFollowTranscript;
}

function scrollToLatestTranscript(): void {
  autoFollowTranscript = true;
  elements.transcriptScroll.scrollTop = elements.transcriptScroll.scrollHeight;
  elements.latestTranscriptButton.hidden = true;
}

function renderCorrectionStatus(status: CorrectionServiceStatus): void {
  const presentation = correctionStatusPresentation(status);
  elements.correctionStatus.textContent = presentation.statusText;
  elements.correctionPrivacy.textContent = presentation.privacyText;
}

function renderCorrectionWarning(message: string): void {
  elements.correctionWarning.textContent = message;
  elements.correctionWarning.hidden = false;
}

function renderSummaryStatus(status: SummaryStatus): void {
  latestSummaryStatus = status;
  elements.summaryProviderStatus.textContent = !status.enabled
    ? '簡易要約は未使用'
    : status.provider === 'openai' ? 'クラウド要約を使用中' : 'ローカルMock要約';
}

function renderLiveSummary(summary: LiveMeetingSummary): void {
  latestLiveSummary = summary;
  const presentation = presentLiveSummary(summary);
  elements.summaryEmpty.hidden = !presentation.empty;
  elements.summaryContent.hidden = presentation.empty;
  elements.summaryTopic.textContent = presentation.topic;
  replaceList(elements.summaryPoints, summary.keyPoints.map((item) => item.text));
  replaceList(elements.summaryDecisions, summary.decisions.map((item) => item.text));
  replaceList(elements.summaryActions, summary.actionItems.map((item) => `${item.task}${item.assignee ? `（担当: ${item.assignee}）` : ''}`));
  replaceList(elements.summaryQuestions, summary.openQuestions.map((item) => item.text));
  renderDetailView();
}

function resetSummaryView(): void {
  elements.summaryEmpty.hidden = false;
  elements.summaryContent.hidden = true;
  elements.summaryTopic.textContent = '';
  replaceList(elements.summaryPoints, []);
  replaceList(elements.summaryDecisions, []);
  replaceList(elements.summaryActions, []);
  replaceList(elements.summaryQuestions, []);
  renderFinalMeetingSummary(elements.detailSummaryText, elements.finalSummary, finalSummaryController.state);
}

function renderDetailView(): void {
  elements.detailTitle.textContent = meetingTitle();
  const date = meetingStartedAt ?? Date.now();
  elements.detailDate.textContent = `${formatMeetingDate(date)}${meetingEndedAt ? ` ・ ${formatDuration(meetingEndedAt - date)}` : ''}`;
  if (finalSummaryController.state.status === 'idle' && latestLiveSummary) {
    const live = presentLiveSummary(latestLiveSummary);
    elements.detailSummaryText.textContent = live.topic;
    elements.finalSummary.replaceChildren();
    elements.finalSummary.hidden = true;
  } else {
    const retryOptions = createFinalSummaryOptions();
    const retryAvailability = finalSummaryController.retryAvailability({
      ...retryOptions,
      meetingId: appState.meetingStarted && appState.meetingEnded ? retryOptions.meetingId : '',
    });
    renderFinalMeetingSummary(elements.detailSummaryText, elements.finalSummary, finalSummaryController.state, {
      retryAvailability,
      retryInProgress: finalSummaryController.retryInProgress,
      onRetry: () => void retryFinalMeetingSummary(),
    });
  }
}

function renderUsage(usage: MeetingUsageSummary): void {
  elements.usageInput.textContent = String(usage.inputTokens);
  elements.usageOutput.textContent = String(usage.outputTokens);
  elements.usageCost.textContent = usage.requestCount === 0
    ? '未使用'
    : usage.estimatedCostUsd === undefined ? '価格設定なし' : `$${usage.estimatedCostUsd.toFixed(6)}`;
}

function replaceList(element: HTMLUListElement, values: string[]): void {
  element.replaceChildren(...values.map((value) => {
    const item = document.createElement('li');
    item.textContent = value;
    return item;
  }));
}

function setAppState(next: AppViewState): void {
  appState = next;
  applyAppView(appState.view, {
    home: elements.homeView,
    meetingSetup: elements.meetingSetupView,
    meeting: elements.meetingView,
    meetingDetail: elements.meetingDetailView,
  });
  renderHomeState();
  if (appState.view === 'meeting-detail') renderDetailView();
}

function renderHomeState(): void {
  const active = appState.meetingStarted && !appState.meetingEnded;
  elements.homeActiveMeeting.hidden = !active;
  elements.newMeetingButton.hidden = active;
  const hasHistory = appState.meetingEnded;
  elements.homeHistoryEmpty.hidden = hasHistory;
  elements.meetingHistoryList.hidden = !hasHistory;
  if (!hasHistory) {
    elements.meetingHistoryList.replaceChildren();
    return;
  }
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  const title = document.createElement('strong');
  title.textContent = meetingTitle();
  const date = document.createElement('time');
  date.textContent = formatMeetingDate(meetingStartedAt ?? Date.now());
  const note = document.createElement('span');
  note.textContent = 'このページ内で保持中';
  button.append(title, date, note);
  button.addEventListener('click', () => setAppState(transitionAppView(appState, 'open-detail')));
  item.append(button);
  elements.meetingHistoryList.replaceChildren(item);
}

function openSettings(): void {
  elements.settingsPanel.hidden = false;
  elements.settingsCloseButton.focus();
}

function closeSettings(): void {
  elements.settingsPanel.hidden = true;
}

function openEndMeetingDialog(): void {
  if (appState.meetingEnded) return;
  elements.endMeetingDialog.hidden = false;
  elements.confirmEndMeetingButton.focus();
}

function closeEndMeetingDialog(): void {
  elements.endMeetingDialog.hidden = true;
}

function updateMeetingTitle(): void {
  elements.meetingTitle.textContent = meetingTitle();
  elements.detailTitle.textContent = meetingTitle();
}

function meetingTitle(): string {
  return elements.meetingTitleInput.value.trim() || '新しい会議';
}

function handleCaptureError(error: MicrophoneError): void {
  renderError(error);
  void provider.abort();
}

function handleProviderError(error: TranscriptionError): void {
  renderError(error);
  renderConnectionNote();
}

function handleProviderWarning(warning: TranscriptionError): void {
  if (warning.code === 'network') {
    renderConnectionNote();
    return;
  }
  renderBufferWarning(warning.message);
}

function renderLevel(level: number): void {
  const percentage = Math.round(Math.max(0, Math.min(1, level)) * 100);
  elements.levelBar.style.transform = `scaleX(${percentage / 100})`;
  elements.levelMeter.setAttribute('aria-valuenow', String(percentage));
  elements.levelLabel.value = `${percentage}%`;
}

function renderError(error: unknown): void {
  const message = getErrorMessage(error);
  elements.error.textContent = message;
  elements.error.hidden = false;
  elements.homeConnectionError.textContent = message;
  elements.homeConnectionError.hidden = false;
}

function renderBufferWarning(message: string): void {
  elements.bufferWarning.textContent = message;
  elements.bufferWarning.hidden = false;
}

function hideBufferWarning(): void {
  elements.bufferWarning.hidden = true;
  elements.bufferWarning.textContent = '';
}

function renderSummaryWarning(message: string): void {
  elements.summaryWarning.textContent = message;
  elements.summaryWarning.hidden = false;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return '音声処理中に問題が発生しました。';
}

function hideError(): void {
  elements.error.hidden = true;
  elements.error.textContent = '';
  elements.homeConnectionError.hidden = true;
  elements.homeConnectionError.textContent = '';
}

function startElapsedTimer(): void {
  window.clearInterval(elapsedTimer);
  renderElapsedTime();
  elapsedTimer = window.setInterval(renderElapsedTime, 250);
}

function renderElapsedTime(): void {
  const elapsed = meetingStartedAt ? Date.now() - meetingStartedAt : 0;
  const text = formatDuration(elapsed);
  elements.elapsedTime.textContent = text;
  elements.elapsedTimeFooter.textContent = text;
}

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`;
}

function formatMeetingDate(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function envNumber(name: keyof ImportMetaEnv, fallback: number): number {
  const value = Number(import.meta.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

renderProviderDetails();
renderMeetingSettingsSummary(elements.meetingSettingsSummary, meetingSettingsSnapshot);
setAppState(appState);
renderCaptureState('idle');
renderTranscriptionState('disconnected');
resetSummaryView();
renderTranscript();
renderUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true });
void correctionClient.status().then(renderCorrectionStatus).catch((error) => renderCorrectionWarning(getErrorMessage(error)));
