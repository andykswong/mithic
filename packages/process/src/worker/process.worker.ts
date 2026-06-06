import { handleRunMessage, type RunMessage } from './process.ts';

function onclose() {
  self.postMessage({ type: 'close' });
  self.close();
};

self.onmessage = (e: MessageEvent<RunMessage>) => {
  if (e.data?.type === 'run') {
    handleRunMessage(e.data).then(onclose, onclose);
  }
};
