/**
 * Node.js stdio stream handlers.
 * Synchronous stdin via fs.readSync(0), stdout/stderr via process.stdout/stderr.write().
 */

import { readSync } from 'node:fs';
import type { InputStreamHandler, SyncInputStreamHandler, SyncOutputStreamHandler } from '../streams.ts';

export class NodeStdinHandler implements SyncInputStreamHandler {
  read(len: number): Uint8Array | undefined {
    const buf = Buffer.alloc(len);
    try {
      const bytesRead = readSync(0, buf, 0, len, null);
      if (bytesRead === 0) return undefined;
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } catch {
      return undefined;
    }
  }

  blockingRead(len: number): Uint8Array {
    const buf = Buffer.alloc(len);
    try {
      const bytesRead = readSync(0, buf, 0, len, null);
      if (bytesRead === 0) throw { tag: 'closed' };
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } catch (e) {
      if (e && typeof e === 'object' && 'tag' in e) throw e;
      throw { tag: 'closed' };
    }
  }
}

export class NodeStdoutHandler implements SyncOutputStreamHandler {
  write(data: Uint8Array): void {
    process.stdout.write(data);
  }

  flush(): void {}
}

export class NodeStderrHandler implements SyncOutputStreamHandler {
  write(data: Uint8Array): void {
    process.stderr.write(data);
  }

  flush(): void {}
}

export class NodeAsyncStdinHandler implements InputStreamHandler {
  #buffer: Uint8Array = new Uint8Array(0);
  #waiting: ((chunk: Uint8Array) => void) | null = null;
  #ended = false;
  #onData: (chunk: Buffer) => void;
  #onEnd: () => void;

  constructor() {
    this.#onData = (chunk: Buffer) => {
      const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (this.#waiting) {
        const cb = this.#waiting;
        this.#waiting = null;
        cb(data);
      } else {
        const merged = new Uint8Array(this.#buffer.length + data.length);
        merged.set(this.#buffer);
        merged.set(data, this.#buffer.length);
        this.#buffer = merged;
      }
    };
    this.#onEnd = () => {
      this.#ended = true;
      if (this.#waiting) {
        const cb = this.#waiting;
        this.#waiting = null;
        cb(new Uint8Array(0));
      }
    };
    process.stdin.on('data', this.#onData);
    process.stdin.on('end', this.#onEnd);
    if (process.stdin.isPaused()) process.stdin.resume();
  }

  read(len: number): Uint8Array | undefined {
    if (this.#buffer.length > 0) {
      const chunk = this.#buffer.subarray(0, len);
      this.#buffer = this.#buffer.subarray(len);
      return new Uint8Array(chunk);
    }
    if (this.#ended) throw { tag: 'closed' };
    return undefined;
  }

  blockingRead(len: number): Promise<Uint8Array> {
    if (this.#buffer.length > 0) {
      const chunk = this.#buffer.subarray(0, len);
      this.#buffer = this.#buffer.subarray(len);
      return Promise.resolve(new Uint8Array(chunk));
    }
    if (this.#ended) return Promise.reject({ tag: 'closed' });
    return new Promise((resolve, reject) => {
      this.#waiting = (chunk) => {
        if (chunk.length === 0) { reject({ tag: 'closed' }); return; }
        this.#buffer = chunk;
        const result = this.#buffer.subarray(0, len);
        this.#buffer = this.#buffer.subarray(len);
        resolve(new Uint8Array(result));
      };
    });
  }

  drop(): void {
    process.stdin.removeListener('data', this.#onData);
    process.stdin.removeListener('end', this.#onEnd);
    process.stdin.pause();
  }
}
