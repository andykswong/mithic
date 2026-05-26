/**
 * Node.js stdio stream handlers.
 * Synchronous stdin via fs.readSync(0), stdout/stderr via process.stdout/stderr.write().
 */

import { readSync } from 'node:fs';
import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '../streams.ts';

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
