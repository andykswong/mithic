import { handleShellInit, type ShellWorkerInit } from './shell.ts';

self.onmessage = (e: MessageEvent<ShellWorkerInit>) => {
  if (e.data?.type === '__shell_init') {
    handleShellInit(e.data).then(
      (code) => { self.postMessage({ type: '__exit', code }); self.close(); },
      () => { self.postMessage({ type: '__exit', code: 1 }); self.close(); },
    );
  }
};
