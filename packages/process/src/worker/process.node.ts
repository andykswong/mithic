import { parentPort } from 'node:worker_threads';
import { handleRunMessage, type RunMessage } from './process.ts';

parentPort?.on('message', (msg: RunMessage) => {
  if (msg?.type === 'run') {
    handleRunMessage(msg).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
});
