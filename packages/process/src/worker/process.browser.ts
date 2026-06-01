import { handleRunMessage, type RunMessage } from './process.ts';

self.onmessage = (e: MessageEvent<RunMessage>) => {
  if (e.data?.type === 'run') {
    handleRunMessage(e.data).then(
      () => self.close(),
      () => self.close(),
    );
  }
};
