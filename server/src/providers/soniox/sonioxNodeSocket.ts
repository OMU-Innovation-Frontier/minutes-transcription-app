import WebSocket from 'ws';
import { SONIOX_ENDPOINT, type ConnectSoniox } from './sonioxProvider.js';
import { sonioxError } from './sonioxTranscript.js';

export const connectSonioxNode: ConnectSoniox = (key) => new Promise((resolve, reject) => {
  const socket = new WebSocket(SONIOX_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 5_000,
    followRedirects: false, perMessageDeflate: false, maxPayload: 1_000_000,
  });
  socket.on('error', () => reject(sonioxError('connect')));
  socket.once('open', () => resolve({
    get bufferedAmount() { return socket.bufferedAmount; },
    send(data) { socket.send(data); },
    close() { socket.close(); },
    listen(onMessage, onEnd) {
      socket.on('message', (data, isBinary) => onMessage(isBinary ? undefined : data.toString()));
      socket.on('close', onEnd);
      socket.on('error', () => onEnd());
    },
  }));
});
