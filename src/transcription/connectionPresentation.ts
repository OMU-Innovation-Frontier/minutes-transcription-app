import type { TranscriptionState } from './types';

export interface ConnectionPresentation {
  label: string;
  listening: boolean;
  terminalError: boolean;
  clearRecoveredMessages: boolean;
}

const LABELS: Record<TranscriptionState, string> = {
  disconnected: '切断',
  connecting: '接続中',
  ready: '準備完了',
  transcribing: '認識中',
  reconnecting: '再接続中',
  resuming: 'セッション再開中',
  replaying: '未送信音声を再送中',
  degraded: '通信低下',
  'utterance-waiting': '発話確定待ち',
  'recognition-queued': '認識待ち',
  recognizing: '認識中',
  'recognition-complete': '認識完了',
  stopped: '停止済み',
  error: 'エラー',
};

export function connectionPresentation(state: TranscriptionState): ConnectionPresentation {
  return {
    label: LABELS[state],
    listening: ['transcribing', 'ready', 'utterance-waiting', 'recognition-queued', 'recognizing', 'recognition-complete'].includes(state),
    terminalError: state === 'error',
    clearRecoveredMessages: ['replaying', 'transcribing', 'ready', 'utterance-waiting', 'recognition-complete'].includes(state),
  };
}
