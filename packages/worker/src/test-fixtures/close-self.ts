self.onmessage = (e: MessageEvent) => {
  if (e.data === 'close') self.close();
  else self.postMessage('alive');
};
