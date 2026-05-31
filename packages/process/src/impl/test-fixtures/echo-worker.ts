import { parentPort } from 'node:worker_threads';

parentPort?.on('message', (msg) => {
  if (msg?.type === 'ping') {
    parentPort?.postMessage({ type: 'pong', payload: msg.payload });
  }
});
