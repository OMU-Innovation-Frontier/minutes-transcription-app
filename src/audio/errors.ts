import { MicrophoneError } from './types';

export function toMicrophoneError(error: unknown): MicrophoneError {
  if (error instanceof MicrophoneError) return error;

  const name = error instanceof DOMException ? error.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicrophoneError(
        'permission-denied',
        'マイクの使用が許可されませんでした。ブラウザのサイト設定でマイクを許可してください。',
        { cause: error },
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new MicrophoneError(
        'device-not-found',
        '利用できるマイクが見つかりません。マイクの接続を確認してください。',
        { cause: error },
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new MicrophoneError(
        'device-busy',
        'マイクを開始できませんでした。他のアプリが使用していないか確認してください。',
        { cause: error },
      );
    default:
      return new MicrophoneError(
        'unknown',
        'マイクの開始中に問題が発生しました。接続とブラウザ設定を確認してください。',
        { cause: error },
      );
  }
}
