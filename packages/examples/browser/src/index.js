import { IoReactor } from '@mithic/core';
import { createConsole } from './console.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// create the console UI
const console = createConsole();

// stub stdin and stdout
const stdin = new ReadableStream({
  start(controller) {
    console.onInput = (val) => controller.enqueue(encoder.encode(val));
  }
});
const stdout = () => new WritableStream({
  lastWrite: 0,
  write(chunk) {
    const writeTime = this.lastWrite = Date.now();
    const content = decoder.decode(chunk, { stream: true });
    setTimeout(() => writeTime === this.lastWrite && console.appendText(content), 100);
  }
});

// run WASM component on Web Worker
const reactor = new IoReactor({ stdin, stdout: stdout(), stderr: stdout() });
const worker = new Worker(new URL('./worker.js', import.meta.url));
worker.postMessage(reactor.addChannel());
