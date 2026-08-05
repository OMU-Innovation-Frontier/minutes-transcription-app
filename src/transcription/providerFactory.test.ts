import { describe, expect, it } from 'vitest';
import { createSpeechToTextProvider } from './providerFactory';

describe('transcription provider selection', () => {
  it('keeps Browser, Mock, WebSocket Mock, Local Whisper, and Groq independently selectable', () => {
    expect(createSpeechToTextProvider('browser').id).toBe('browser');
    expect(createSpeechToTextProvider('mock').id).toBe('mock');
    expect(createSpeechToTextProvider('websocket').id).toBe('websocket');
    const local = createSpeechToTextProvider('local-whisper');
    expect(local.id).toBe('local-whisper');
    expect(local.audioCaptureMode).toBe('pcm16-16khz');
    expect(local.isMock).toBe(false);
    const groq = createSpeechToTextProvider('groq-whisper');
    expect(groq.id).toBe('groq-whisper');
    expect(groq.label).toBe('Groq Whisper（無料枠）');
    expect(groq.audioCaptureMode).toBe('pcm16-16khz');
    expect(groq.isMock).toBe(false);
  });
});
