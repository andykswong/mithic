import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { createCallHandler } from './call-handler.ts';
import { MemoryFsProvider } from '../vfs/providers/memory.ts';
import {
  FILE, STDIN, STDOUT,
  FS_OPEN, FS_STAT, FS_READ, FS_WRITE, FS_CLOSE, FS_MKDIR, FS_READDIR,
  FS_UNLINK, FS_RMDIR, FS_RENAME, FS_SYMLINK, FS_READLINK,
  HTTP_SEND,
  INPUT_STREAM_READ, OUTPUT_STREAM_WRITE,
} from './calls.ts';

describe('createCallHandler - filesystem', () => {
  it('dispatches FS_STAT to VFS provider', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider({ files: { '/hello.txt': 'hello world' } }) });

    const stat = await handler(FS_STAT | FILE, null, { path: '/hello.txt' }) as { type: string; size: bigint };
    strictEqual(stat.type, 'file');
    strictEqual(stat.size, 11n);
  });

  it('dispatches FS_OPEN + FS_READ + FS_CLOSE', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider({ files: { '/data.txt': 'abcde' } }) });

    const handleId = await handler(FS_OPEN | FILE, null, { path: '/data.txt', flags: { read: true } }) as number;
    ok(typeof handleId === 'number');

    const data = await handler(FS_READ | FILE, handleId, { offset: 0, len: 5 }) as Uint8Array;
    strictEqual(new TextDecoder().decode(data), 'abcde');

    await handler(FS_CLOSE | FILE, handleId, null);  });

  it('dispatches FS_OPEN + FS_WRITE', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider() });

    const handleId = await handler(FS_OPEN | FILE, null, { path: '/new.txt', flags: { create: true, write: true } }) as number;
    const written = await handler(FS_WRITE | FILE, handleId, { data: new TextEncoder().encode('test'), offset: 0 }) as number;
    strictEqual(written, 4);
    await handler(FS_CLOSE | FILE, handleId, null);

    const stat = await handler(FS_STAT | FILE, null, { path: '/new.txt' }) as { size: bigint };
    strictEqual(stat.size, 4n);
  });

  it('dispatches FS_MKDIR + FS_READDIR', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider() });

    await handler(FS_MKDIR | FILE, null, { path: '/mydir' });
    const entries = await handler(FS_READDIR | FILE, null, { path: '/' }) as Array<{ name: string }>;
    ok(entries.some(e => e.name === 'mydir'));
  });

  it('dispatches FS_UNLINK', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider({ files: { '/del.txt': 'x' } }) });

    await handler(FS_UNLINK | FILE, null, { path: '/del.txt' });

    try {
      await handler(FS_STAT | FILE, null, { path: '/del.txt' });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      ok(e instanceof Error || (typeof e === 'object' && e !== null));
    }
  });

  it('dispatches FS_RMDIR', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider() });

    await handler(FS_MKDIR | FILE, null, { path: '/emptydir' });
    await handler(FS_RMDIR | FILE, null, { path: '/emptydir' });

    const entries = await handler(FS_READDIR | FILE, null, { path: '/' }) as Array<{ name: string }>;
    ok(!entries.some(e => e.name === 'emptydir'));
  });

  it('dispatches FS_RENAME', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider({ files: { '/old.txt': 'content' } }) });

    await handler(FS_RENAME | FILE, null, { oldPath: '/old.txt', newPath: '/new.txt' });

    const stat = await handler(FS_STAT | FILE, null, { path: '/new.txt' }) as { type: string };
    strictEqual(stat.type, 'file');
  });

  it('dispatches FS_SYMLINK + FS_READLINK', async () => {
    const handler = createCallHandler({ fs: new MemoryFsProvider({ files: { '/target.txt': 'data' } }) });

    await handler(FS_SYMLINK | FILE, null, { target: '/target.txt', linkPath: '/link.txt' });
    const target = await handler(FS_READLINK | FILE, null, { path: '/link.txt' }) as string;
    strictEqual(target, '/target.txt');
  });
});

describe('createCallHandler - HTTP', () => {
  it('dispatches HTTP_SEND to HTTP client', async () => {
    const mockClient = {
      async send(req: { method: string; url: string }) {
        return { status: 200, headers: [] as [string, string][], body: new TextEncoder().encode(`OK ${req.method}`) };
      },
    };
    const handler = createCallHandler({ http: mockClient });

    const response = await handler(HTTP_SEND, null, { method: 'GET', url: 'http://example.com', headers: [] }) as { status: number; body: Uint8Array };
    strictEqual(response.status, 200);
    ok(new TextDecoder().decode(response.body).includes('OK GET'));
  });
});

describe('createCallHandler - stdio', () => {
  it('routes stdin read via options', async () => {
    const handler = createCallHandler({
      stdin: { blockingRead(_len: number) { return new TextEncoder().encode('input-data'); } },
    });

    const data = await handler(INPUT_STREAM_READ | STDIN, null, { len: 10 }) as Uint8Array;
    strictEqual(new TextDecoder().decode(data), 'input-data');
  });

  it('routes stdout write via options', async () => {
    const received: Uint8Array[] = [];
    const handler = createCallHandler({
      stdout: { async write(data: Uint8Array) { received.push(data); } },
    });

    const outData = new TextEncoder().encode('hello');
    await handler(OUTPUT_STREAM_WRITE | STDOUT, null, { data: outData });
    strictEqual(received.length, 1);
  });
});
