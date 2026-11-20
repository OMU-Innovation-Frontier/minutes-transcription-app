import { createMeetingRecord } from './history/meetingRecord';
import { loadMeetingDraft, saveMeetingDraft, removeMeetingDraft } from './history/meetingDraft';
import './styles.css';
import { downloadMeetingFile, meetingExportFilename, shareMeeting } from './history/meetingExport';
import type { LiveMeetingSummary, MeetingUsageSummary } from '../shared/summary';
import type { CorrectionServiceStatus } from '../shared/correction';
import { AudioCapture } from './audio/audioCapture';
import type { AudioChunkSink, CaptureState, MicrophoneError } from './audio/types';
import { CorrectionCoordinator, CorrectionHttpClient } from './correction/correctionClient';
import { correctionStatusPresentation } from './correction/transcriptPresentation';
import { initializeLocalEvaluationRecorder } from './localRecording/localEvaluationRecorder';
import { IndexedDbMeetingHistoryRepository } from './history/indexedDbMeetingHistoryRepository';
import { MeetingHistoryListController } from './history/meetingHistoryListController';
import { MeetingHistoryDetailController } from './history/meetingHistoryDetailController';
import {
  meetingHistoryDisplayTitle,
  renderPersistedMeetingHistoryDetail,
} from './history/meetingHistoryDetailView';
import {
  MeetingHistoryDeleteController,
  type MeetingHistoryDeleteState,
} from './history/meetingHistoryDeleteController';
import {
  handleMeetingHistoryDeleteDialogKeydown,
  renderMeetingHistoryDelete,
} from './history/meetingHistoryDeleteView';
import {
  renderMeetingHistoryList,
  type CurrentPageMeetingHistoryItem,
} from './history/meetingHistoryListView';
import {
  createEndedMeetingSnapshot,
  MEETING_HISTORY_SAVE_WARNING,
  MeetingHistoryPersistenceCoordinator,
  saveSucceededFinalSummary,
  type EndedMeetingSnapshot,
} from './history/meetingHistoryPersistence';
import { IncrementalSummaryCoordinator, SummaryHttpClient, type SummaryStatus } from './summary/summaryClient';
import { isBrowserSpeechRecognitionSupported } from './transcription/browserProvider';
import { connectionPresentation } from './transcription/connectionPresentation';
import { createSpeechToTextProvider, getDefaultProviderKind } from './transcription/providerFactory';
import { TranscriptStore } from './transcription/transcriptStore';
import type {
  SpeechToTextProvider,
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
import {
  buildExternalProcessingDisclosure,
  createInitialMeetingSetupDraft,
  createMeetingSettingsSnapshot,
  meetingTranscriptionCatalog,
  requiresExternalProcessingAcknowledgement,
  validateMeetingSetupDraft,
  type MeetingExternalProcessingRequirements,
  type MeetingSettingsSnapshot,
  type MeetingSetupDraft,
} from './meetingSetup/meetingSetup';
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
  accessLogoutForm: requiredElement<HTMLFormElement>('access-logout-form'),
  accessLogoutButton: requiredElement<HTMLButtonElement>('access-logout-button'),
  homeView: requiredElement<HTMLElement>('home-view'),
  meetingView: requiredElement<HTMLElement>('meeting-view'),
  meetingDetailView: requiredElement<HTMLElement>('meeting-detail-view'),
  workspace: requiredElement<HTMLElement>('workspace'),
  historyToggle: requiredElement<HTMLButtonElement>('history-toggle'),
  newMeetingButton: requiredElement<HTMLButtonElement>('new-meeting-button'),
  setupForm: requiredElement<HTMLFormElement>('meeting-setup-form'),
  setupError: requiredElement<HTMLElement>('setup-error'),
  setupLanguage: requiredElement<HTMLSelectElement>('setup-language'),
  setupProvider: requiredElement<HTMLSelectElement>('setup-provider'),
  setupProviderDescription: requiredElement<HTMLElement>('setup-provider-description'),
  setupCorrection: requiredElement<HTMLInputElement>('setup-correction'),
  setupLiveSummary: requiredElement<HTMLInputElement>('setup-live-summary'),
  setupFinalSummary: requiredElement<HTMLInputElement>('setup-final-summary'),
  setupExternalConfirmation: requiredElement<HTMLElement>('setup-external-confirmation'),
  setupExternalDescription: requiredElement<HTMLElement>('setup-external-description'),
  setupExternalAck: requiredElement<HTMLInputElement>('setup-external-ack'),
  setupCreateButton: requiredElement<HTMLButtonElement>('setup-create-button'),
  resumeMeetingButton: requiredElement<HTMLButtonElement>('resume-meeting-button'),
  homeActiveMeeting: requiredElement<HTMLElement>('home-active-meeting'),
  homeHistoryEmpty: requiredElement<HTMLElement>('home-history-empty'),
  homeHistoryStatus: requiredElement<HTMLElement>('home-history-status'),
  homeHistoryStatusMessage: requiredElement<HTMLElement>('home-history-status-message'),
  homeHistoryRetryButton: requiredElement<HTMLButtonElement>('home-history-retry-button'),
  renameMeetingHistoryDialog: requiredElement<HTMLElement>('rename-meeting-history-dialog'),
  renameMeetingHistoryForm: requiredElement<HTMLFormElement>('rename-meeting-history-form'),
  renameMeetingHistoryInput: requiredElement<HTMLInputElement>('rename-meeting-history-input'),
  renameMeetingHistoryStatus: requiredElement<HTMLElement>('rename-meeting-history-status'),
  cancelRenameMeetingHistoryButton: requiredElement<HTMLButtonElement>('cancel-rename-meeting-history-button'),
  saveRenameMeetingHistoryButton: requiredElement<HTMLButtonElement>('save-rename-meeting-history-button'),
  homeHistoryNotification: requiredElement<HTMLElement>('home-history-notification'),
  meetingHistoryList: requiredElement<HTMLOListElement>('meeting-history-list'),
  historyTitle: requiredElement<HTMLElement>('history-title'),
  homeConnectionError: requiredElement<HTMLElement>('home-connection-error'),
  detailHomeButton: requiredElement<HTMLButtonElement>('detail-home-button'),
  homeSettingsButton: requiredElement<HTMLButtonElement>('home-settings-button'),
  settingsPanel: requiredElement<HTMLElement>('settings-panel'),
  settingsCloseButton: requiredElement<HTMLButtonElement>('settings-close-button'),
  meetingSettingsSummary: requiredElement<HTMLElement>('meeting-settings-summary'),
  meetingTitle: requiredElement<HTMLElement>('meeting-title'),
  endMeetingButton: requiredElement<HTMLButtonElement>('end-meeting-button'),
  endMeetingDialog: requiredElement<HTMLElement>('end-meeting-dialog'),
  endMeetingTitleInput: requiredElement<HTMLInputElement>('end-meeting-title-input'),
  cancelEndMeetingButton: requiredElement<HTMLButtonElement>('cancel-end-meeting-button'),
  confirmEndMeetingButton: requiredElement<HTMLButtonElement>('confirm-end-meeting-button'),
  detailTitle: requiredElement<HTMLElement>('detail-title'),
  detailDate: requiredElement<HTMLElement>('detail-date'),
  detailHistoryStatus: requiredElement<HTMLElement>('detail-history-status'),
  detailHistoryStatusMessage: requiredElement<HTMLElement>('detail-history-status-message'),
  detailHistoryRetryButton: requiredElement<HTMLButtonElement>('detail-history-retry-button'),
  detailSummarySection: requiredElement<HTMLElement>('detail-summary-section'),
  detailSummaryTitle: requiredElement<HTMLElement>('detail-summary-title'),
  detailSummaryText: requiredElement<HTMLElement>('detail-summary-text'),
  detailTranscriptSection: requiredElement<HTMLElement>('detail-transcript-section'),
  detailTranscript: requiredElement<HTMLOListElement>('detail-transcript'),
  detailTranscriptEmpty: requiredElement<HTMLElement>('detail-transcript-empty'),
  detailPersistenceNote: requiredElement<HTMLElement>('detail-persistence-note'),
  persistedDetailActions: requiredElement<HTMLElement>('persisted-detail-actions'),
  deleteMeetingHistoryButton: requiredElement<HTMLButtonElement>('delete-meeting-history-button'),
  deleteMeetingHistoryStatus: requiredElement<HTMLElement>('delete-meeting-history-status'),
  retryDeleteMeetingHistoryButton: requiredElement<HTMLButtonElement>('retry-delete-meeting-history-button'),
  deleteMeetingHistoryDialog: requiredElement<HTMLElement>('delete-meeting-history-dialog'),
  deleteDialogTitle: requiredElement<HTMLElement>('delete-dialog-title'),
  deleteMeetingHistoryTitle: requiredElement<HTMLElement>('delete-meeting-history-title'),
  deleteMeetingHistoryProgress: requiredElement<HTMLElement>('delete-meeting-history-progress'),
  cancelDeleteMeetingHistoryButton: requiredElement<HTMLButtonElement>('cancel-delete-meeting-history-button'),
  confirmDeleteMeetingHistoryButton: requiredElement<HTMLButtonElement>('confirm-delete-meeting-history-button'),
  startButton: requiredElement<HTMLButtonElement>('start-button'),
  stopButton: requiredElement<HTMLButtonElement>('stop-button'),
  reconnectButton: requiredElement<HTMLButtonElement>('reconnect-button'),
  recordingStatus: requiredElement<HTMLElement>('recording-status'),
  recordingStatusLabel: requiredElement<HTMLElement>('recording-status-label'),
  recognitionStatus: requiredElement<HTMLElement>('recognition-status'),
  recognitionStatusLabel: requiredElement<HTMLElement>('recognition-status-label'),
  microphoneState: requiredElement<HTMLElement>('microphone-state'),
  providerLabel: requiredElement<HTMLElement>('provider-label'),
  levelBar: requiredElement<HTMLElement>('level-bar'),
  levelMeter: requiredElement<HTMLElement>('level-meter'),
  levelLabel: requiredElement<HTMLOutputElement>('level-label'),
  elapsedTime: requiredElement<HTMLElement>('elapsed-time'),
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
  localWhisperStats: requiredElement<HTMLElement>('local-whisper-stats'),
  localWhisperModel: requiredElement<HTMLElement>('local-whisper-model'),
  localWhisperLanguage: requiredElement<HTMLElement>('local-whisper-language'),
  localWhisperQueue: requiredElement<HTMLElement>('local-whisper-queue'),
  localWhisperAudioDuration: requiredElement<HTMLElement>('local-whisper-audio-duration'),
  localWhisperProcessingTime: requiredElement<HTMLElement>('local-whisper-processing-time'),
  localWhisperRtf: requiredElement<HTMLElement>('local-whisper-rtf'),
  summarizeNowButton: requiredElement<HTMLButtonElement>('summarize-now-button'),
  manualSummaryStatus: requiredElement<HTMLElement>('manual-summary-status'),
  interimSummaryHistory: requiredElement<HTMLElement>('interim-summary-history'),
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
let endedMeetingSnapshot: EndedMeetingSnapshot | null = null;
type MeetingDetailSource = { kind: 'current' } | { kind: 'persisted'; meetingId: string } | null;
let meetingDetailSource: MeetingDetailSource = null;
let currentMeetingPersisted = false;
let pageUnloading = false;
let handledDeleteState: MeetingHistoryDeleteState | null = null;
let homeDeleteTarget: { meetingId: string; button: HTMLButtonElement } | null = null;
let historyExportInProgress = false;
let renameMeetingId: string | null = null;
let renameInProgress = false;
let meetingSetupDraft = {
  ...createInitialMeetingSetupDraft(getDefaultProviderKind()),
  title: '新規会議',
};
let meetingTitle = meetingSetupDraft.title;
let startAfterSettings = false;
let settingsTrigger: HTMLElement | null = null;
let summaryStatusRequest: Promise<void> | null = null;
let reconnectAttempt = 0;
let reconnectMaxAttempts = 0;
let summaryCoordinator: IncrementalSummaryCoordinator | null = null;
let correctionCoordinator: CorrectionCoordinator | null = null;
let correctionServiceStatus: CorrectionServiceStatus | null = null;
const correctionCoordinators: CorrectionCoordinator[] = [];
let latestLiveSummary: LiveMeetingSummary | null = null;
let latestSummaryStatus: SummaryStatus | null = null;
let setupSummaryStatus: SummaryStatus | null = null;
let meetingSummaryExternalAllowed = false;
let autoFollowTranscript = true;
let renderedSentenceCount = 0;
let renderedInterimText = '';

const summaryClient = new SummaryHttpClient();
const correctionClient = new CorrectionHttpClient();
const transcriptStore = new TranscriptStore({ onChange: handleTranscriptChange });
const localEvaluationRecorder = initializeLocalEvaluationRecorder();
const finalSummaryController = new FinalMeetingSummaryController(() => {
  renderDetailView();
  renderHomeState();
});
const meetingHistoryRepository = createMeetingHistoryRepository();
const meetingHistoryPersistence = new MeetingHistoryPersistenceCoordinator(
  meetingHistoryRepository,
  renderSummaryWarning,
);
const meetingHistoryListController = new MeetingHistoryListController(
  meetingHistoryRepository,
  renderHomeState,
);
const meetingHistoryDetailController = new MeetingHistoryDetailController(
  meetingHistoryRepository,
  renderDetailView,
);
const meetingHistoryDeleteController = new MeetingHistoryDeleteController(
  meetingHistoryRepository,
  handleMeetingHistoryDeleteChange,
);

const recognitionOption = elements.setupProvider.querySelector<HTMLOptionElement>('option[value="browser"]');
if (recognitionOption && !isBrowserSpeechRecognitionSupported()) {
  recognitionOption.disabled = true;
  recognitionOption.textContent = 'ブラウザー音声認識（この環境では利用不可）';
}
elements.setupProvider.value = meetingSetupDraft.transcriptionProvider;
elements.setupLanguage.value = meetingSetupDraft.language;
elements.setupCorrection.checked = meetingSetupDraft.correctionEnabled;
elements.setupLiveSummary.checked = meetingSetupDraft.liveSummaryEnabled;
elements.setupFinalSummary.checked = meetingSetupDraft.finalSummaryEnabled;

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
elements.setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (startAfterSettings) beginMeeting();
});
for (const input of [elements.setupLanguage, elements.setupProvider, elements.setupCorrection, elements.setupLiveSummary, elements.setupFinalSummary, elements.setupExternalAck]) {
  input.addEventListener('input', () => {
    if (input !== elements.setupLanguage && input !== elements.setupExternalAck) elements.setupExternalAck.checked = false;
    renderMeetingSetup();
  });
}
elements.historyToggle.addEventListener('click', () => {
  setHistoryExpanded(elements.historyToggle.getAttribute('aria-expanded') !== 'true');
});
elements.resumeMeetingButton.addEventListener('click', () => {
  clearPersistedMeetingDetail();
  setAppState(transitionAppView(appState, 'resume-meeting'));
  elements.meetingTitle.focus();
});
elements.cancelRenameMeetingHistoryButton.addEventListener('click', closeRenameMeetingHistory);
elements.renameMeetingHistoryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveRenamedMeeting();
});
elements.homeHistoryRetryButton.addEventListener('click', () => void meetingHistoryListController.retry());
elements.detailHomeButton.addEventListener('click', returnHomeFromDetail);
elements.detailHistoryRetryButton.addEventListener('click', () => void meetingHistoryDetailController.retry());
elements.deleteMeetingHistoryButton.addEventListener('click', openDeleteMeetingHistoryDialog);
elements.cancelDeleteMeetingHistoryButton.addEventListener('click', cancelDeleteMeetingHistory);
elements.confirmDeleteMeetingHistoryButton.addEventListener('click', () => {
  if (meetingHistoryDeleteController.state.status === 'failed') retryDeleteMeetingHistory();
  else void meetingHistoryDeleteController.delete();
});
elements.retryDeleteMeetingHistoryButton.addEventListener('click', retryDeleteMeetingHistory);
elements.homeSettingsButton.addEventListener('click', () => openSettings());
elements.settingsCloseButton.addEventListener('click', closeSettings);
elements.startButton.addEventListener('click', () => void startSession());
elements.stopButton.addEventListener('click', () => void pauseSession());
elements.reconnectButton.addEventListener('click', () => provider.reconnect?.());
elements.endMeetingButton.addEventListener('click', openEndMeetingDialog);
elements.cancelEndMeetingButton.addEventListener('click', closeEndMeetingDialog);
elements.confirmEndMeetingButton.addEventListener('click', () => void finishMeeting());
elements.endMeetingTitleInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  void finishMeeting();
});
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
window.addEventListener('keydown', handleGlobalKeydown);
window.addEventListener('pagehide', () => {
  transcriptStore.finalizeRecording();
  persistActiveMeeting();
  pageUnloading = true;
  window.clearInterval(elapsedTimer);
  meetingHistoryListController.dispose();
  meetingHistoryDetailController.dispose();
  meetingHistoryDeleteController.dispose();
  summaryCoordinator?.dispose();
  for (const coordinator of correctionCoordinators) coordinator.dispose();
  meetingHistoryPersistence.dispose();
  localEvaluationRecorder.dispose();
  void capture.stop();
  void provider.abort();
  void meetingHistoryRepository?.close().catch(() => undefined);
});

function beginMeeting(): void {
  if (sessionTransition || finalSummaryController.retryInProgress || (appState.meetingStarted && !appState.meetingEnded)) return;
  const requirements = correctionExternalProcessingRequirements();
  if (validateMeetingSetupDraft(meetingSetupDraft, requirements)) {
    openSettings(true);
    return;
  }
  const settings = createMeetingSettingsSnapshot(meetingSetupDraft, new Date().toISOString(), requirements);
  closeSettings();
  setHistoryExpanded(false);
  clearPersistedMeetingDetail();
  resetMeetingData();
  meetingSettingsSnapshot = settings;
  meetingSummaryExternalAllowed = Boolean(setupSummaryStatus?.enabled && setupSummaryStatus.apiUsed && meetingSetupDraft.externalProcessingAcknowledged);
  currentMeetingId = createSessionId();
  meetingStartedAt = null;
  meetingEndedAt = null;
  meetingTitle = settings.title;
  elements.meetingTitle.textContent = meetingTitle;
  renderMeetingSettingsSummary(elements.meetingSettingsSummary, settings);
  setAppState(transitionAppView(appState, 'start-meeting'));
  elements.meetingTitle.focus();
  void startSession();
}

function renderMeetingSetup(): void {
  meetingSetupDraft = {
    ...meetingSetupDraft,
    language: elements.setupLanguage.value as MeetingSetupDraft['language'],
    transcriptionProvider: elements.setupProvider.value as MeetingSetupDraft['transcriptionProvider'],
    correctionEnabled: elements.setupCorrection.checked,
    liveSummaryEnabled: elements.setupLiveSummary.checked,
    finalSummaryEnabled: elements.setupFinalSummary.checked,
    externalProcessingAcknowledged: elements.setupExternalAck.checked,
  };
  const option = meetingTranscriptionCatalog.find((item) => item.id === meetingSetupDraft.transcriptionProvider);
  const requirements = correctionExternalProcessingRequirements();
  const error = validateMeetingSetupDraft(meetingSetupDraft, requirements);
  elements.setupProviderDescription.textContent = option?.description ?? '';
  elements.setupExternalDescription.textContent = buildExternalProcessingDisclosure(meetingSetupDraft, requirements);
  elements.setupExternalConfirmation.hidden = !requiresExternalProcessingAcknowledgement(meetingSetupDraft, requirements);
  elements.setupError.textContent = error ?? '';
  elements.setupError.hidden = !error;
  elements.setupCreateButton.hidden = !startAfterSettings;
  elements.setupCreateButton.disabled = Boolean(error);
}

function refreshSetupSummaryStatus(): void {
  if (summaryStatusRequest) return;
  summaryStatusRequest = summaryClient.status().then((status) => {
    if (!pageUnloading) setupSummaryStatus = status;
  }).catch(() => {
    setupSummaryStatus = null;
  }).finally(() => {
    summaryStatusRequest = null;
    if (!pageUnloading) renderMeetingSetup();
  });
}

function resetMeetingData(): void {
  meetingSummaryExternalAllowed = false;
  summaryCoordinator?.dispose();
  summaryCoordinator = null;
  for (const coordinator of correctionCoordinators.splice(0)) coordinator.dispose();
  correctionCoordinator = null;
  transcriptStore.clear();
  currentSessionId = '';
  latestLiveSummary = null;
  latestSummaryStatus = null;
  endedMeetingSnapshot = null;
  currentMeetingPersisted = false;
  meetingHistoryPersistence.reset();
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
    await stopFailedRecording();
    renderError(error);
    return;
  }

  try {
    await provider.start({
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
    meetingHasRecorded = true;
    persistActiveMeeting();
  } catch (error) {
    await stopFailedRecording();
    renderError(error);
  } finally {
    sessionTransition = false;
    renderControls();
  }
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
  await summaryCoordinator?.waitForLive();
  if (firstError) renderError(firstError);
  sessionTransition = false;
  renderControls();
}

async function finishMeeting(): Promise<void> {
  if (sessionTransition || elements.endMeetingDialog.hidden || !appState.meetingStarted || appState.meetingEnded) return;
  meetingTitle = elements.endMeetingTitleInput.value.trim() || meetingTitle;
  closeEndMeetingDialog();
  if (captureState !== 'idle') await pauseSession();
  sessionTransition = true;
  renderControls();
  meetingEndedAt = Date.now();
  const settings = meetingSettingsSnapshot;
  let endedSnapshot: EndedMeetingSnapshot | null = null;
  if (settings) {
    try {
      endedSnapshot = createEndedMeetingSnapshot({
        meetingId: currentMeetingId,
        settingsSnapshot: settings,
        title: meetingTitle,
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
        sentences: transcriptStore.snapshot().completedSentences,
      });
      endedMeetingSnapshot = endedSnapshot;
    } catch {
      renderSummaryWarning(MEETING_HISTORY_SAVE_WARNING);
    }
  }
  window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  meetingDetailSource = { kind: 'current' };
  meetingHistoryDetailController.clear();
  appState = transitionAppView(appState, 'end-meeting');
  setAppState(appState);
  elements.detailTitle.focus();
  const initialHistorySaved = endedSnapshot
    ? await meetingHistoryPersistence.saveEndedMeeting(endedSnapshot)
    : false;
  if (initialHistorySaved) {
    try { removeMeetingDraft(currentMeetingId); } catch { /* Keep the saved history available. */ }
    currentMeetingPersisted = true;
    renderDetailView();
    void meetingHistoryListController.refresh();
  }
  if (endedSnapshot && (!meetingHistoryPersistence.isActive(endedSnapshot) || endedMeetingSnapshot !== endedSnapshot)) {
    sessionTransition = false;
    return;
  }
  if (settings?.finalSummaryEnabled && !summaryCoordinator) {
    summaryCoordinator = createSummaryCoordinator(currentMeetingId);
  }
  const finalSummaryState = await finalSummaryController.complete(createFinalSummaryOptions(endedSnapshot));
  if (endedSnapshot) {
    const finalSummarySaved = await saveSucceededFinalSummary(
      meetingHistoryPersistence,
      endedSnapshot,
      finalSummaryState,
      latestSummaryStatus?.apiUsed ?? null,
    );
    if (finalSummarySaved) {
      currentMeetingPersisted = true;
      renderDetailView();
      void meetingHistoryListController.refresh();
    }
  }
  sessionTransition = false;
  renderControls();
  renderHomeState();
  renderDetailView();
}

function createFinalSummaryOptions(snapshot: EndedMeetingSnapshot | null = endedMeetingSnapshot): CompleteFinalMeetingSummaryOptions {
  const settings = snapshot?.settingsSnapshot ?? null;
  return {
    meetingId: snapshot?.meetingId ?? '',
    settings,
    sentences: snapshot?.sentences ?? [],
    provider: () => latestSummaryStatus?.provider ?? null,
    finalize: async (sentences) => {
      if (!summaryCoordinator) return null;
      if (settings?.liveSummaryEnabled) await summaryCoordinator.waitForLive();
      return summaryCoordinator.finalize(sentences);
    },
  };
}

async function retryFinalMeetingSummary(): Promise<void> {
  if (!appState.meetingStarted || !appState.meetingEnded) return;
  const snapshot = endedMeetingSnapshot;
  const options = createFinalSummaryOptions(snapshot);
  if (!finalSummaryController.retryAvailability(options).available) {
    renderDetailView();
    return;
  }
  const retry = finalSummaryController.retry(options);
  renderControls();
  const finalSummaryState = await retry;
  if (snapshot) {
    const finalSummarySaved = await saveSucceededFinalSummary(
      meetingHistoryPersistence,
      snapshot,
      finalSummaryState,
      latestSummaryStatus?.apiUsed ?? null,
    );
    if (finalSummarySaved) {
      currentMeetingPersisted = true;
      renderDetailView();
      void meetingHistoryListController.refresh();
    }
  }
  renderControls();
}

elements.summarizeNowButton.addEventListener('click', () => void summarizeNow());

function renderManualSummaryControls(): void {
  const enabled = Boolean(meetingSettingsSnapshot?.liveSummaryEnabled);
  const busy = summaryCoordinator?.busy ?? false;
  elements.summarizeNowButton.disabled = !enabled || !summaryCoordinator || busy
    || sessionTransition || appState.meetingEnded
    || !summaryCoordinator.hasNewSentences(transcriptStore.snapshot().completedSentences);
  elements.summarizeNowButton.textContent = busy ? '要約を作成中…' : 'ここまでを要約';
  elements.manualSummaryStatus.textContent = !enabled
    ? '会議設定で「ボタンで途中要約を作る」を有効にしてください。'
    : busy ? '要約中も録音・文字起こしは続きます。'
    : '新しい確定発言を、これまでの要約も踏まえてまとめます。途中要約はこの画面を開いている間残ります。';
}

async function summarizeNow(): Promise<void> {
  if (elements.summarizeNowButton.disabled || !summaryCoordinator) return;
  const coordinator = summaryCoordinator;
  coordinator.add(transcriptStore.snapshot().completedSentences);
  elements.summaryWarning.hidden = true;
  const operation = coordinator.flushLive();
  renderManualSummaryControls();
  try { await operation; } finally {
    if (summaryCoordinator === coordinator && !pageUnloading) renderManualSummaryControls();
  }
}

function createSummaryCoordinator(meetingId: string): IncrementalSummaryCoordinator {
  return new IncrementalSummaryCoordinator(summaryClient, meetingId, envNumber('VITE_SUMMARY_SENTENCE_BATCH_SIZE', 3), {
    onStatus: renderSummaryStatus,
    onLiveSummary: renderLiveSummary,
    onUsage: renderUsage,
    onError: (error) => renderSummaryWarning(error.message),
  }, meetingSummaryExternalAllowed, false, setupSummaryStatus?.provider);
}

function createCorrectionCoordinator(sessionId: string): CorrectionCoordinator {
  return new CorrectionCoordinator(correctionClient, transcriptStore, sessionId, {
    onStatus: renderCorrectionStatus,
    onError: (error) => renderCorrectionWarning(error.message),
  }, { meetingId: currentMeetingId || sessionId });
}

function handleTranscriptChange(): void {
  persistActiveMeeting();
  const snapshot = transcriptStore.snapshot();
  renderTranscript();
  correctionCoordinator?.add(snapshot.completedSentences);
  renderManualSummaryControls();
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
  elements.accessLogoutButton.disabled = appState.meetingStarted && !appState.meetingEnded;
  renderManualSummaryControls();
  const active = captureState !== 'idle';
  elements.startButton.disabled = active || sessionTransition || appState.meetingEnded;
  elements.startButton.textContent = meetingHasRecorded ? '録音を再開' : '録音を開始';
  elements.stopButton.disabled = !active || sessionTransition;
  elements.endMeetingButton.disabled = sessionTransition || appState.meetingEnded;
  elements.newMeetingButton.disabled = sessionTransition || finalSummaryController.retryInProgress;
  elements.reconnectButton.disabled = !active || !provider.reconnect
    || !(transcriptionState === 'reconnecting' || transcriptionState === 'degraded' || transcriptionState === 'error');
  elements.finalizeSentenceButton.disabled = !active;
}

function renderProviderDetails(): void {
  elements.providerLabel.textContent = provider.label;
  elements.localWhisperStats.hidden = provider.id !== 'local-whisper' && provider.id !== 'groq-whisper';
  elements.localWhisperLanguage.textContent = meetingSettingsSnapshot?.language === 'en-US' ? 'English' : '日本語';
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

  if (meetingDetailSource?.kind !== 'persisted') {
    renderCurrentDetailTranscript(snapshot.completedSentences);
  }
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

function renderCurrentDetailTranscript(sentences = transcriptStore.snapshot().completedSentences): void {
  const detailItems = sentences.map((sentence, index) => createSentenceElement(sentence, index, sentences.length, {
    onRetryCorrection: retryCorrection,
  }));
  elements.detailTranscript.replaceChildren(...detailItems);
  elements.detailTranscriptEmpty.textContent = '文字起こしはありません。';
  elements.detailTranscriptEmpty.hidden = detailItems.length > 0;
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
  correctionServiceStatus = status;
  const presentation = correctionStatusPresentation(status);
  elements.correctionStatus.textContent = presentation.statusText;
  elements.correctionPrivacy.textContent = presentation.privacyText;
  renderMeetingSetup();
}

function correctionExternalProcessingRequirements(): MeetingExternalProcessingRequirements {
  return {
    correctionStatusKnown: correctionServiceStatus !== null,
    correctionExternalTransmission: Boolean(correctionServiceStatus?.enabled && correctionServiceStatus.externalTransmission),
    summaryStatusKnown: setupSummaryStatus !== null,
    summaryEnabled: setupSummaryStatus?.enabled ?? false,
    summaryExternalTransmission: Boolean(setupSummaryStatus?.enabled && setupSummaryStatus.apiUsed),
    summaryProvider: setupSummaryStatus?.provider,
  };
}

function renderCorrectionWarning(message: string): void {
  elements.correctionWarning.textContent = message;
  elements.correctionWarning.hidden = false;
}

function renderSummaryStatus(status: SummaryStatus): void {
  latestSummaryStatus = status;
  elements.summaryProviderStatus.textContent = !status.enabled
    ? '簡易要約は未使用'
    : status.provider === 'groq' ? 'Groq要約を使用中' : status.provider === 'openai' ? 'OpenAI要約を使用中' : 'ローカルMock要約';
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
  const entry = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = `途中要約 ${elements.interimSummaryHistory.childElementCount + 1}（${new Date().toLocaleTimeString('ja-JP')}）`;
  const content = elements.summaryContent.cloneNode(true) as HTMLElement;
  content.removeAttribute('id');
  content.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  entry.append(heading, content);
  elements.interimSummaryHistory.append(entry);
  renderDetailView();
}

function resetSummaryView(): void {
  elements.interimSummaryHistory.replaceChildren();
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
  if (meetingDetailSource?.kind === 'persisted') {
    renderPersistedMeetingHistoryDetail({
      title: elements.detailTitle,
      date: elements.detailDate,
      historyStatus: elements.detailHistoryStatus,
      historyStatusMessage: elements.detailHistoryStatusMessage,
      historyRetryButton: elements.detailHistoryRetryButton,
      summarySection: elements.detailSummarySection,
      summaryTitle: elements.detailSummaryTitle,
      summaryStatus: elements.detailSummaryText,
      summaryContent: elements.finalSummary,
      transcriptSection: elements.detailTranscriptSection,
      transcript: elements.detailTranscript,
      transcriptEmpty: elements.detailTranscriptEmpty,
      persistenceNote: elements.detailPersistenceNote,
    }, meetingHistoryDetailController.state, (value) => formatMeetingDate(Date.parse(value)), formatDuration);
    renderMeetingHistoryDeleteState();
    return;
  }

  elements.detailHistoryStatus.hidden = true;
  elements.detailHistoryRetryButton.hidden = true;
  elements.detailSummarySection.hidden = false;
  elements.detailSummaryTitle.textContent = '簡易要約';
  elements.detailTranscriptSection.hidden = false;
  elements.detailTitle.textContent = meetingTitle;
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
  renderCurrentDetailTranscript();
  elements.detailPersistenceNote.hidden = false;
  elements.detailPersistenceNote.textContent = isCurrentMeetingPersisted()
    ? 'この会議はこの端末のブラウザー内に保存されています。サイトデータを削除すると失われ、別の端末やブラウザープロフィールには同期されません。'
    : '会議履歴の端末内保存を確認できませんでした。この画面を閉じる前に内容を確認してください。';
  renderMeetingHistoryDeleteState();
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
    meeting: elements.meetingView,
    meetingDetail: elements.meetingDetailView,
  });
  renderHomeState();
  renderControls();
  if (appState.view === 'meeting-detail') renderDetailView();
}

function renderHomeState(): void {
  const active = appState.meetingStarted && !appState.meetingEnded;
  elements.resumeMeetingButton.setAttribute('aria-pressed', String(appState.view === 'meeting'));
  elements.homeActiveMeeting.hidden = !active;
  elements.newMeetingButton.hidden = active;
  renderMeetingHistoryList({
    list: elements.meetingHistoryList,
    empty: elements.homeHistoryEmpty,
    status: elements.homeHistoryStatus,
    statusMessage: elements.homeHistoryStatusMessage,
    retryButton: elements.homeHistoryRetryButton,
  }, meetingHistoryListController.state, currentPageMeetingHistory(), (value) => formatMeetingDate(Date.parse(value)), openPersistedMeetingDetail, {
    onDelete: openHomeDeleteMeetingHistoryDialog,
    onRename: openRenameMeetingHistory,
    onPdf: (meetingId) => void exportMeetingFromHome(meetingId, 'pdf'),
    onShare: (meetingId) => void exportMeetingFromHome(meetingId, 'share'),
    disabled: (meetingId) => meetingHistoryDeleteController.state.status === 'deleting'
      || historyExportInProgress
      || (meetingId === currentMeetingId && (sessionTransition || finalSummaryController.retryInProgress)),
  });
}

async function exportMeetingFromHome(meetingId: string, mode: 'pdf' | 'share'): Promise<void> {
  if (historyExportInProgress || meetingHistoryDeleteController.state.status === 'deleting') return;
  const record = meetingHistoryListController.state.records.find((item) => item.meetingId === meetingId);
  if (!record) { showHistoryNotification('会議履歴が見つかりません。履歴を再読み込みしてください。', true); return; }
  if (mode === 'pdf' && !record.finalSummary) {
    showHistoryNotification('最終要約を作成してからPDFを保存してください。', true);
    return;
  }
  historyExportInProgress = true;
  renderHomeState();
  try {
    if (mode === 'share') {
      const result = await shareMeeting(record);
      if (!pageUnloading) showHistoryNotification(result === 'downloaded'
        ? '共有用テキストをダウンロードしました。送りたい相手に添付してください。'
        : result === 'cancelled' ? '共有をキャンセルしました。' : '共有先への受け渡しが完了しました。', false);
    } else {
      showHistoryNotification('PDFを作成しています。', false);
      const { createMeetingPdf } = await import('./history/meetingPdf');
      const bytes = await createMeetingPdf(record);
      if (pageUnloading) return;
      downloadMeetingFile(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), meetingExportFilename(record, 'pdf'));
      showHistoryNotification('PDFのダウンロードを開始しました。', false);
    }
  } catch {
    if (!pageUnloading) showHistoryNotification(mode === 'pdf'
      ? 'PDFを作成できませんでした。時間をおいてもう一度お試しください。'
      : '共有できませんでした。PDFをダウンロードして添付することもできます。', true);
  } finally {
    historyExportInProgress = false;
    if (!pageUnloading) { renderHomeState(); elements.historyTitle.focus(); }
  }
}

function openRenameMeetingHistory(meetingId: string, title: string): void {
  if (renameMeetingId || !meetingHistoryRepository) return;
  renameMeetingId = meetingId;
  hideHistoryNotification();
  elements.renameMeetingHistoryStatus.hidden = true;
  elements.renameMeetingHistoryInput.value = title;
  elements.renameMeetingHistoryDialog.hidden = false;
  elements.workspace.inert = true;
  elements.renameMeetingHistoryInput.focus();
  elements.renameMeetingHistoryInput.select();
}

function closeRenameMeetingHistory(): void {
  if (renameInProgress || !renameMeetingId) return;
  renameMeetingId = null;
  elements.renameMeetingHistoryDialog.hidden = true;
  elements.workspace.inert = false;
  elements.historyTitle.focus();
}

async function saveRenamedMeeting(): Promise<void> {
  const meetingId = renameMeetingId;
  if (!meetingId || renameInProgress || !meetingHistoryRepository) return;
  const title = elements.renameMeetingHistoryInput.value.trim();
  const status = elements.renameMeetingHistoryStatus;
  if (!title || title.length > 80) {
    status.textContent = '会議名を1〜80文字で入力してください。';
    status.hidden = false;
    elements.renameMeetingHistoryInput.focus();
    return;
  }

  status.textContent = '会議名を保存しています。';
  status.hidden = false;
  renameInProgress = true;
  elements.renameMeetingHistoryInput.readOnly = true;
  elements.cancelRenameMeetingHistoryButton.disabled = true;
  elements.saveRenameMeetingHistoryButton.disabled = true;
  let updated = false;
  let message = '会議名を保存できませんでした。もう一度お試しください。';
  try {
    updated = await meetingHistoryRepository.renameById(meetingId, title);
    if (pageUnloading) return;
    if (updated) {
      if (endedMeetingSnapshot?.meetingId === meetingId) {
        meetingTitle = title;
        renderDetailView();
      }
      if (meetingDetailSource?.kind === 'persisted' && meetingDetailSource.meetingId === meetingId) {
        meetingHistoryDetailController.clear();
        void meetingHistoryDetailController.open(meetingId);
      }
    }
    await meetingHistoryListController.refresh();
    message = updated
      ? '会議名を変更しました。'
      : 'この会議履歴は削除されたか、見つかりませんでした。';
  } catch {
    // The dialog stays open so the entered name can be retried.
    if (pageUnloading) return;
    status.textContent = message;
    elements.renameMeetingHistoryInput.focus();
    return;
  } finally {
    renameInProgress = false;
    elements.renameMeetingHistoryInput.readOnly = false;
    elements.cancelRenameMeetingHistoryButton.disabled = false;
    elements.saveRenameMeetingHistoryButton.disabled = false;
  }
  if (pageUnloading) return;
  closeRenameMeetingHistory();
  const refreshFailed = meetingHistoryListController.state.status === 'failed';
  showHistoryNotification(updated && refreshFailed
    ? '会議名を変更しました。履歴を再読み込みすると表示が更新されます。'
    : message, !updated);
}

function openHomeDeleteMeetingHistoryDialog(meetingId: string, title: string, button: HTMLButtonElement): void {
  if (!elements.endMeetingDialog.hidden || meetingHistoryDeleteController.state.status === 'deleting') return;
  if (meetingId === currentMeetingId && (sessionTransition || finalSummaryController.retryInProgress)) return;
  if (!meetingHistoryListController.state.records.some((record) => record.meetingId === meetingId)) return;
  homeDeleteTarget = { meetingId, button };
  hideHistoryNotification();
  if (!meetingHistoryDeleteController.confirm(meetingId, title)) { homeDeleteTarget = null; return; }
  elements.cancelDeleteMeetingHistoryButton.focus();
}

function currentPageMeetingHistory(): CurrentPageMeetingHistoryItem | null {
  const snapshot = endedMeetingSnapshot;
  if (!appState.meetingEnded || !snapshot) return null;
  return {
    meetingId: snapshot.meetingId,
    title: meetingTitle,
    occurredAt: snapshot.endedAt,
    utteranceCount: snapshot.sentences.length,
    hasFinalSummary: finalSummaryController.state.status === 'succeeded',
    openDetail: openCurrentMeetingDetail,
  };
}

function openCurrentMeetingDetail(): void {
  if (meetingHistoryDeleteController.state.status === 'deleting') return;
  meetingHistoryDeleteController.clear();
  meetingHistoryDetailController.clear();
  meetingDetailSource = { kind: 'current' };
  setHistoryExpanded(false);
  setAppState(transitionAppView(appState, 'open-detail'));
  elements.detailTitle.focus();
}

function openPersistedMeetingDetail(meetingId: string): void {
  if (meetingHistoryDeleteController.state.status === 'deleting') return;
  meetingHistoryDeleteController.clear();
  meetingDetailSource = { kind: 'persisted', meetingId };
  setHistoryExpanded(false);
  setAppState(transitionAppView(appState, 'open-persisted-detail'));
  elements.detailTitle.focus();
  void meetingHistoryDetailController.open(meetingId);
}

function returnHomeFromDetail(): void {
  if (meetingHistoryDeleteController.state.status === 'deleting') return;
  const returningFromPersistedDetail = meetingDetailSource?.kind === 'persisted';
  clearPersistedMeetingDetail();
  const nextAction = appState.meetingStarted && !appState.meetingEnded ? 'resume-meeting' : 'open-home';
  setAppState(transitionAppView(appState, nextAction));
  if (returningFromPersistedDetail) {
    setHistoryExpanded(true);
    elements.historyTitle.focus();
  } else {
    elements.newMeetingButton.focus();
  }
}

function clearPersistedMeetingDetail(): void {
  if (meetingDetailSource?.kind !== 'persisted') return;
  meetingHistoryDeleteController.clear();
  meetingHistoryDetailController.clear();
  meetingDetailSource = null;
}

function renderMeetingHistoryDeleteState(): void {
  renderMeetingHistoryDelete({
    actions: elements.persistedDetailActions,
    deleteButton: elements.deleteMeetingHistoryButton,
    status: elements.deleteMeetingHistoryStatus,
    retryButton: elements.retryDeleteMeetingHistoryButton,
    dialog: elements.deleteMeetingHistoryDialog,
    dialogTargetTitle: elements.deleteMeetingHistoryTitle,
    dialogProgress: elements.deleteMeetingHistoryProgress,
    cancelButton: elements.cancelDeleteMeetingHistoryButton,
    confirmButton: elements.confirmDeleteMeetingHistoryButton,
  }, meetingHistoryDetailController.state, meetingHistoryDeleteController.state,
  meetingDetailSource?.kind === 'persisted', homeDeleteTarget ?? undefined);
}

function openDeleteMeetingHistoryDialog(): void {
  if (!elements.endMeetingDialog.hidden) return;
  if (meetingDetailSource?.kind !== 'persisted') return;
  homeDeleteTarget = null;
  const detailState = meetingHistoryDetailController.state;
  if (detailState.status !== 'ready' || detailState.record.meetingId !== meetingDetailSource.meetingId) return;
  hideHistoryNotification();
  if (!meetingHistoryDeleteController.confirm(
    detailState.record.meetingId,
    meetingHistoryDisplayTitle(detailState.record),
  )) return;
  elements.cancelDeleteMeetingHistoryButton.focus();
}

function cancelDeleteMeetingHistory(): void {
  if (!['confirming', 'failed'].includes(meetingHistoryDeleteController.state.status)) return;
  const homeTarget = homeDeleteTarget;
  homeDeleteTarget = null;
  meetingHistoryDeleteController.cancel();
  if (homeTarget) elements.historyTitle.focus();
  else elements.deleteMeetingHistoryButton.focus();
}

function retryDeleteMeetingHistory(): void {
  const operation = meetingHistoryDeleteController.retry();
  if (meetingHistoryDeleteController.state.status === 'deleting') elements.deleteDialogTitle.focus();
  void operation;
}

function handleMeetingHistoryDeleteChange(state: MeetingHistoryDeleteState): void {
  renderMeetingHistoryDeleteState();
  renderHomeState();
  if (state.status === 'failed' && homeDeleteTarget) elements.confirmDeleteMeetingHistoryButton.focus();
  else if (state.status === 'failed') elements.retryDeleteMeetingHistoryButton.focus();
  if ((state.status === 'deleted' || state.status === 'not_found') && handledDeleteState !== state) {
    handledDeleteState = state;
    void finalizeMeetingHistoryDelete(state);
  }
}

async function finalizeMeetingHistoryDelete(
  state: Extract<MeetingHistoryDeleteState, { status: 'deleted' | 'not_found' }>,
): Promise<void> {
  if (pageUnloading) return;
  const fromHome = homeDeleteTarget?.meetingId === state.meetingId;
  if (!fromHome && (meetingDetailSource?.kind !== 'persisted' || meetingDetailSource.meetingId !== state.meetingId)) return;
  homeDeleteTarget = null;
  const deletingCurrentMeeting = endedMeetingSnapshot?.meetingId === state.meetingId;
  if (deletingCurrentMeeting) {
    endedMeetingSnapshot = null;
    currentMeetingPersisted = false;
    meetingHistoryPersistence.reset();
  }

  const viewingDeletedMeeting = meetingDetailSource?.kind === 'persisted'
    ? meetingDetailSource.meetingId === state.meetingId
    : appState.view === 'meeting-detail' && deletingCurrentMeeting;
  if (viewingDeletedMeeting) returnHomeFromDetail();
  await meetingHistoryListController.refresh();
  if (pageUnloading) return;

  const refreshFailed = meetingHistoryListController.state.status === 'failed';
  const message = state.status === 'not_found'
    ? 'この会議履歴はすでに削除されているか、見つかりませんでした。'
    : refreshFailed
      ? '会議履歴を削除しましたが、一覧を更新できませんでした。履歴の再読み込みをお試しください。'
      : '会議履歴を削除しました。';
  showHistoryNotification(message, refreshFailed);
  setHistoryExpanded(true);
  elements.historyTitle.focus();
  meetingHistoryDeleteController.clear();
}

function showHistoryNotification(message: string, danger: boolean): void {
  elements.homeHistoryNotification.textContent = message;
  elements.homeHistoryNotification.classList.toggle('inline-alert--danger', danger);
  elements.homeHistoryNotification.hidden = false;
  elements.homeHistoryNotification.setAttribute('aria-hidden', 'false');
}

function hideHistoryNotification(): void {
  elements.homeHistoryNotification.textContent = '';
  elements.homeHistoryNotification.classList.remove('inline-alert--danger');
  elements.homeHistoryNotification.hidden = true;
  elements.homeHistoryNotification.setAttribute('aria-hidden', 'true');
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (handleMeetingHistoryDeleteDialogKeydown({
    actions: elements.persistedDetailActions,
    deleteButton: elements.deleteMeetingHistoryButton,
    status: elements.deleteMeetingHistoryStatus,
    retryButton: elements.retryDeleteMeetingHistoryButton,
    dialog: elements.deleteMeetingHistoryDialog,
    dialogTargetTitle: elements.deleteMeetingHistoryTitle,
    dialogProgress: elements.deleteMeetingHistoryProgress,
    cancelButton: elements.cancelDeleteMeetingHistoryButton,
    confirmButton: elements.confirmDeleteMeetingHistoryButton,
  }, meetingHistoryDeleteController.state, event, cancelDeleteMeetingHistory)) return;
  if (event.key !== 'Escape') return;
  if (renameMeetingId) closeRenameMeetingHistory();
  else if (!elements.endMeetingDialog.hidden) closeEndMeetingDialog();
  else if (!elements.settingsPanel.hidden) closeSettings();
}

function isCurrentMeetingPersisted(): boolean {
  if (currentMeetingPersisted) return true;
  return Boolean(currentMeetingId && meetingHistoryListController.state.records.some(
    ({ meetingId }) => meetingId === currentMeetingId,
  ));
}

function setHistoryExpanded(expanded: boolean): void {
  elements.historyToggle.setAttribute('aria-expanded', String(expanded));
}

function openSettings(forRecording = false): void {
  if (elements.settingsPanel.hidden) settingsTrigger = document.activeElement as HTMLElement | null;
  const active = appState.meetingStarted && !appState.meetingEnded;
  startAfterSettings = forRecording;
  elements.setupForm.hidden = active;
  elements.meetingSettingsSummary.hidden = !active || !meetingSettingsSnapshot;
  elements.settingsPanel.hidden = false;
  elements.workspace.inert = true;
  renderMeetingSetup();
  if (!active) refreshSetupSummaryStatus();
  elements.settingsCloseButton.focus();
}

function closeSettings(): void {
  if (elements.settingsPanel.hidden) return;
  elements.settingsPanel.hidden = true;
  elements.workspace.inert = false;
  startAfterSettings = false;
  settingsTrigger?.focus();
  settingsTrigger = null;
}

function openEndMeetingDialog(): void {
  if (sessionTransition || appState.meetingEnded || !elements.deleteMeetingHistoryDialog.hidden) return;
  const transcript = transcriptStore.snapshot();
  const suggestedTitle = latestLiveSummary?.topic?.trim()
    || transcript.completedSentences.find((sentence) => sentence.displayText.trim())?.displayText
    || transcript.interimDisplayText;
  const hasDefaultTitle = meetingTitle === meetingSetupDraft.title || meetingTitle === '新しい会議';
  elements.endMeetingTitleInput.value = hasDefaultTitle
    ? suggestedTitle.replace(/\s+/gu, ' ').trim().slice(0, 80) || meetingTitle
    : meetingTitle;
  elements.endMeetingDialog.hidden = false;
  elements.workspace.inert = true;
  elements.endMeetingTitleInput.focus();
  elements.endMeetingTitleInput.select();
}

function closeEndMeetingDialog(): void {
  elements.endMeetingDialog.hidden = true;
  elements.workspace.inert = false;
  elements.endMeetingButton.focus();
}

function handleCaptureError(error: MicrophoneError): void {
  renderError(error);
  void provider.abort();
}

function handleProviderError(error: TranscriptionError): void {
  renderError(error);
  renderConnectionNote();
  if (!sessionTransition && captureState === 'recording') void stopFailedRecording();
}

async function stopFailedRecording(): Promise<void> {
  sessionTransition = true;
  renderControls();
  try {
    await capture.stop();
  } catch {
    renderError('マイクの停止に失敗しました。ページを閉じてください。');
  }
  try {
    await provider.abort();
  } catch {
    // Preserve the original recognition error.
  } finally {
    transcriptStore.finalizeRecording();
    handleTranscriptChange();
    sessionTransition = false;
    renderControls();
  }
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

function createMeetingHistoryRepository(): IndexedDbMeetingHistoryRepository | null {
  try {
    return window.indexedDB ? new IndexedDbMeetingHistoryRepository(window.indexedDB) : null;
  } catch {
    return null;
  }
}

function persistActiveMeeting(): void {
  if (!meetingSettingsSnapshot || !currentMeetingId || appState.meetingEnded || pageUnloading) return;
  try {
    saveMeetingDraft(createMeetingRecord({
      meetingId: currentMeetingId,
      createdAt: meetingSettingsSnapshot.createdAt,
      startedAt: meetingStartedAt === null ? null : new Date(meetingStartedAt).toISOString(),
      endedAt: null,
      updatedAt: new Date().toISOString(),
      title: meetingTitle,
      settingsSnapshot: meetingSettingsSnapshot,
      sentences: transcriptStore.snapshot().completedSentences,
    }));
  } catch {
    renderSummaryWarning('会議の途中保存に失敗しました。ページを閉じる前に会議を終了して保存してください。');
  }
}

function recoverActiveMeeting(): void {
  try {
    const draft = loadMeetingDraft();
    if (!draft) return;
    currentMeetingId = draft.meetingId;
    meetingSettingsSnapshot = draft.settingsSnapshot;
    meetingStartedAt = draft.startedAt === null ? null : Date.parse(draft.startedAt);
    meetingHasRecorded = draft.startedAt !== null;
    meetingTitle = draft.title ?? draft.settingsSnapshot.title;
    elements.meetingTitle.textContent = meetingTitle;
    provider = createSpeechToTextProvider(draft.settingsSnapshot.transcriptionProvider);
    transcriptStore.restoreSentences(draft.transcript.utterances.map((utterance) => ({
      id: utterance.sentenceId,
      sessionId: draft.meetingId,
      rawSegmentIds: utterance.sourceSegmentIds,
      rawText: utterance.rawText,
      displayText: utterance.correctedText ?? utterance.rawText,
      revision: utterance.revision,
      language: utterance.language,
      startTime: utterance.startTime,
      endTime: utterance.endTime,
      completionReason: 'recording_stopped',
      ...(utterance.correctedText === null ? {} : { correction: {
        rawText: utterance.rawText, correctedText: utterance.correctedText,
        status: 'succeeded' as const, changes: [], uncertainParts: [],
        sourceSegmentIds: utterance.sourceSegmentIds,
      } }),
    })));
    // Restoring a draft never starts the microphone or external processing.
    meetingSummaryExternalAllowed = false;
    appState = { view: 'meeting', meetingStarted: true, meetingEnded: false };
  } catch {
    renderSummaryWarning('途中の会議を復元できませんでした。ブラウザーの保存設定を確認してください。');
  }
}

recoverActiveMeeting();
renderMeetingSetup();
if (import.meta.env.PROD) {
  void fetch('/auth/session').then(async response => {
    if (!response.ok || pageUnloading) return;
    const state: unknown = await response.json();
    if (!state || typeof state !== 'object' || !('expiresAt' in state) || typeof state.expiresAt !== 'number' || pageUnloading) return;
    elements.accessLogoutForm.hidden = false;
    renderControls();
  }).catch(() => undefined);
}
elements.accessLogoutForm.addEventListener('submit', event => {
  if (appState.meetingStarted && !appState.meetingEnded) event.preventDefault();
});
renderProviderDetails();
renderMeetingSettingsSummary(elements.meetingSettingsSummary, meetingSettingsSnapshot);
void meetingHistoryListController.load();
setAppState(appState);
renderCaptureState('idle');
renderTranscriptionState('disconnected');
resetSummaryView();
renderTranscript();
renderUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true });
void correctionClient.status().then(renderCorrectionStatus).catch((error) => renderCorrectionWarning(getErrorMessage(error)));
