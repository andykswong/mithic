// Simulates async module initialization — messages should be queued
await new Promise(resolve => setTimeout(resolve, 50));
self.onmessage = (e: MessageEvent) => {
  self.postMessage('delayed: ' + e.data);
};
