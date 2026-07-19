export interface FunAsrTransport {
  connect(): Promise<void>;
  sendControl(message: unknown): Promise<void>;
  sendAudio(audio: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onMessage(callback: (message: unknown) => void): () => void;
  onError(callback: (error: unknown) => void): () => void;
  onClose(callback: () => void): () => void;
}

export type FunAsrTransportFactory = () => FunAsrTransport;
