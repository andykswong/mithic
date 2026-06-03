self.onmessage = (e: MessageEvent) => {
  self.postMessage('echo: ' + e.data);
};
