import { describe, expect, it } from 'vitest';
import { connectionPresentation } from './connectionPresentation';

describe('connectionPresentation', () => {
  it('clears a previous error after reconnect and replay recovery', () => {
    expect(connectionPresentation('error')).toMatchObject({ terminalError: true, clearRecoveredMessages: false });
    expect(connectionPresentation('replaying')).toMatchObject({ terminalError: false, clearRecoveredMessages: true });
    expect(connectionPresentation('transcribing')).toMatchObject({ terminalError: false, clearRecoveredMessages: true });
  });
});
