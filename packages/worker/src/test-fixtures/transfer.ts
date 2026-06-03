self.onmessage = (e: MessageEvent) => {
  const port = e.data.port as MessagePort;
  port.postMessage('transferred');
};
