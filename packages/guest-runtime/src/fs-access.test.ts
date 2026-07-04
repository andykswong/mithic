import { expect, test } from 'vitest';
import { openRoot, createStorageManager, readPath, writePath } from './fs-access.ts';
import type { SyscallHook } from './fetch.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Node type for a mock VFS entry. */
type Node = { type: 'file'; data: Uint8Array } | { type: 'directory' };

/**
 * A tiny in-memory mock kernel fs driven by the fs/* syscall wire shapes:
 * `fs/stat`, `fs/open`, `fs/read`, `fs/write`, `fs/close`, `fs/mkdir`,
 * `fs/readdir`, `fs/unlink`, `fs/rmdir`. Mirrors the kernel's return shapes
 * closely enough to drive the façade. The integer fd is allocated here.
 */
function mockFs(): { syscall: SyscallHook; tree: Map<string, Node> } {
  const tree = new Map<string, Node>();
  tree.set('/', { type: 'directory' });
  const fds = new Map<number, { path: string; offset: number }>();
  let nextFd = 3;

  const norm = (p: string): string => {
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.join('/');
  };
  const parentOf = (p: string): string => {
    const n = norm(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  };
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

  const syscall: SyscallHook = async (call, args) => {
    const path = typeof args.path === 'string' ? norm(args.path) : '';
    switch (call) {
      case 'fs/stat': {
        const node = tree.get(path);
        if (!node) throw enoent(path);
        const size = node.type === 'file' ? node.data.byteLength : 0;
        return { type: node.type, size, mode: 0o644, mtime: new Date(), atime: new Date(), ctime: new Date(), linkCount: 1 };
      }
      case 'fs/mkdir': {
        if (!tree.has(parentOf(path))) throw enoent(parentOf(path));
        tree.set(path, { type: 'directory' });
        return {};
      }
      case 'fs/readdir': {
        const node = tree.get(path);
        if (!node || node.type !== 'directory') throw enoent(path);
        const prefix = path === '/' ? '/' : path + '/';
        const entries: { name: string; type: string }[] = [];
        for (const [k, v] of tree) {
          if (k === path || !k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (rest.includes('/') || rest === '') continue;
          entries.push({ name: rest, type: v.type });
        }
        return entries;
      }
      case 'fs/open': {
        const oflags = (args.oflags ?? {}) as { create?: boolean; truncate?: boolean; write?: boolean };
        let node = tree.get(path);
        if (!node) {
          if (!oflags.create) throw enoent(path);
          node = { type: 'file', data: new Uint8Array() };
          tree.set(path, node);
        } else if (node.type === 'file' && oflags.truncate) {
          node.data = new Uint8Array();
        }
        const fd = nextFd++;
        fds.set(fd, { path, offset: 0 });
        return { fd };
      }
      case 'fs/read': {
        const e = fds.get(Number(args.fd));
        if (!e) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
        const node = tree.get(e.path);
        if (!node || node.type !== 'file') throw enoent(e.path);
        const offset = typeof args.offset === 'number' ? args.offset : e.offset;
        const len = typeof args.len === 'number' ? args.len : node.data.byteLength - offset;
        const slice = node.data.subarray(offset, offset + Math.max(0, len));
        if (typeof args.offset !== 'number') e.offset += slice.byteLength;
        return new Uint8Array(slice);
      }
      case 'fs/write': {
        const e = fds.get(Number(args.fd));
        if (!e) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
        const node = tree.get(e.path);
        if (!node || node.type !== 'file') throw enoent(e.path);
        const data = args.data as Uint8Array;
        const offset = typeof args.offset === 'number' ? args.offset : e.offset;
        const end = offset + data.byteLength;
        if (end > node.data.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(node.data, 0);
          node.data = grown;
        }
        node.data.set(data, offset);
        if (typeof args.offset !== 'number') e.offset += data.byteLength;
        return { written: data.byteLength };
      }
      case 'fs/close': {
        fds.delete(Number(args.fd));
        return {};
      }
      case 'fs/unlink':
      case 'fs/rmdir': {
        if (!tree.has(path)) throw enoent(path);
        tree.delete(path);
        return {};
      }
      default:
        throw new Error(`unexpected syscall: ${call}`);
    }
  };
  return { syscall, tree };
}

test('B3: openRoot() returns a directory-handle-shaped root', () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  expect(root.kind).toBe('directory');
  expect(root.name).toBe('');
});

test('B3: getDirectoryHandle({create}) makes a dir; getFileHandle({create}) makes a file', async () => {
  const { syscall, tree } = mockFs();
  const root = openRoot(syscall);

  const dir = await root.getDirectoryHandle('sub', { create: true });
  expect(dir.kind).toBe('directory');
  expect(dir.name).toBe('sub');
  expect(tree.get('/sub')).toMatchObject({ type: 'directory' });

  const file = await dir.getFileHandle('a.txt', { create: true });
  expect(file.kind).toBe('file');
  expect(file.name).toBe('a.txt');
  expect(tree.get('/sub/a.txt')).toMatchObject({ type: 'file' });
});

test('B3: getFileHandle without create on a missing file rejects (NotFoundError)', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  await expect(root.getFileHandle('missing.txt')).rejects.toMatchObject({ name: 'NotFoundError' });
});

test('B3: write a file via createWritable() then read it back via getFile().text()', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);

  const fh = await root.getFileHandle('hello.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('Hello, ');
  await w.write(enc.encode('world'));
  await w.close();

  const file = await fh.getFile();
  expect(file.name).toBe('hello.txt');
  expect(file.size).toBe('Hello, world'.length);
  expect(await file.text()).toBe('Hello, world');
});

test('B3: getFile().arrayBuffer() yields the raw bytes', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  const fh = await root.getFileHandle('bin', { create: true });
  const w = await fh.createWritable();
  await w.write(enc.encode('abc'));
  await w.close();

  const file = await fh.getFile();
  const ab = await file.arrayBuffer();
  expect(new Uint8Array(ab)).toEqual(enc.encode('abc'));
});

test('B3: getFile().stream() pulls fs/read chunks into a ReadableStream', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  const fh = await root.getFileHandle('big.txt', { create: true });
  const w = await fh.createWritable();
  // Larger than one read chunk to exercise multi-chunk streaming.
  const payload = 'x'.repeat(200_000);
  await w.write(payload);
  await w.close();

  const file = await fh.getFile();
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  expect(total).toBe(payload.length);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  expect(dec.decode(merged)).toBe(payload);
});

test('B3: directory async iterators (keys/values/entries) enumerate children', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);

  const dir = await root.getDirectoryHandle('d', { create: true });
  await dir.getFileHandle('f1', { create: true });
  await dir.getFileHandle('f2', { create: true });
  await dir.getDirectoryHandle('sub', { create: true });

  const keys: string[] = [];
  for await (const k of dir.keys()) keys.push(k);
  expect(keys.sort()).toEqual(['f1', 'f2', 'sub']);

  const kinds: Record<string, string> = {};
  for await (const [name, handle] of dir.entries()) kinds[name] = handle.kind;
  expect(kinds).toEqual({ f1: 'file', f2: 'file', sub: 'directory' });

  const values: string[] = [];
  for await (const h of dir.values()) values.push(`${h.name}:${h.kind}`);
  expect(values.sort()).toEqual(['f1:file', 'f2:file', 'sub:directory']);
});

test('B3: the default async iterator yields [name, handle] entries', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  const dir = await root.getDirectoryHandle('e', { create: true });
  await dir.getFileHandle('only', { create: true });

  const got: Array<[string, string]> = [];
  for await (const [name, handle] of dir) got.push([name, handle.kind]);
  expect(got).toEqual([['only', 'file']]);
});

test('B3: removeEntry deletes a child file', async () => {
  const { syscall, tree } = mockFs();
  const root = openRoot(syscall);
  const dir = await root.getDirectoryHandle('r', { create: true });
  await dir.getFileHandle('gone', { create: true });
  expect(tree.has('/r/gone')).toBe(true);

  await dir.removeEntry('gone');
  expect(tree.has('/r/gone')).toBe(false);
});

test('B3: createWritable() truncates by default (overwrites prior content)', async () => {
  const { syscall } = mockFs();
  const root = openRoot(syscall);
  const fh = await root.getFileHandle('t.txt', { create: true });

  let w = await fh.createWritable();
  await w.write('original-long-content');
  await w.close();

  w = await fh.createWritable();
  await w.write('new');
  await w.close();

  const file = await fh.getFile();
  expect(await file.text()).toBe('new');
});

// ---------------------------------------------------------------------------
// Q1: StorageManager surface (getDirectory / getCurrentDirectory) + path helpers
// ---------------------------------------------------------------------------

/** A minimal Guest-shaped stub carrying just what readPath/writePath read. */
function guestStub(syscall: SyscallHook, cwd: string) {
  return { cwd, fs: createStorageManager(syscall, cwd) };
}

test('Q1: getDirectory() returns the VFS root handle', async () => {
  const { syscall } = mockFs();
  const fs = createStorageManager(syscall, '/work');
  const root = await fs.getDirectory();
  expect(root.kind).toBe('directory');
  expect(root.name).toBe('');
});

test('Q1: getCurrentDirectory() returns a handle rooted at cwd', async () => {
  const { syscall, tree } = mockFs();
  tree.set('/work', { type: 'directory' });
  const fs = createStorageManager(syscall, '/work');
  const cwd = await fs.getCurrentDirectory();
  expect(cwd.kind).toBe('directory');
  expect(cwd.name).toBe('work');
  // writing a name-relative file into cwd lands at /work/<name>
  const fh = await cwd.getFileHandle('out.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('hi');
  await w.close();
  expect(tree.get('/work/out.txt')).toMatchObject({ type: 'file' });
});

test('Q1: getCurrentDirectory() of root cwd is the root handle (name empty)', async () => {
  const { syscall } = mockFs();
  const fs = createStorageManager(syscall, '/');
  const cwd = await fs.getCurrentDirectory();
  expect(cwd.kind).toBe('directory');
  expect(cwd.name).toBe('');
});

test('Q1: getCurrentDirectory() walks a nested cwd path', async () => {
  const { syscall, tree } = mockFs();
  tree.set('/a', { type: 'directory' });
  tree.set('/a/b', { type: 'directory' });
  const fs = createStorageManager(syscall, '/a/b');
  const cwd = await fs.getCurrentDirectory();
  expect(cwd.name).toBe('b');
  const fh = await cwd.getFileHandle('c.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('x');
  await w.close();
  expect(tree.get('/a/b/c.txt')).toMatchObject({ type: 'file' });
});

test('Q1: writePath/readPath round-trip bytes by absolute path', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/work');
  const payload = new Uint8Array([0, 255, 128]);
  await writePath(g, '/a.bin', payload);
  expect(Array.from(await readPath(g, '/a.bin'))).toEqual([0, 255, 128]);
});

// BYTE-LOSS regression (relay decode): on the QuickJS/isolated-vm relay path a
// Uint8Array does not survive the JSON round-trip — the kernel's fs/read bytes
// arrive as a plain number[] (or a {data:number[]} wrapper). The façade must decode
// both to a byte-exact Uint8Array, in addition to the transferable Uint8Array form.
test('BYTE-LOSS: readPath decodes a relay-style fs/read number[] result byte-exact', async () => {
  const bytes = [0, 0x7f, 0x80, 0xff, 0xe2, 0x82, 0xac, 65];
  let served = false;
  const relaySyscall: SyscallHook = async (call) => {
    switch (call) {
      case 'fs/stat': return { type: 'file', size: bytes.length };
      case 'fs/open': return { fd: 3 };
      // Relay backends serialize bytes as a plain number[] (not a Uint8Array).
      case 'fs/read': {
        if (served) return []; // EOF: empty array
        served = true;
        return bytes.slice();
      }
      case 'fs/close': return {};
      default: throw new Error(`unexpected: ${call}`);
    }
  };
  const g = guestStub(relaySyscall, '/');
  expect(Array.from(await readPath(g, '/a.bin'))).toEqual(bytes);
});

test('BYTE-LOSS: readPath decodes a relay-style {data:number[]} fs/read result byte-exact', async () => {
  const bytes = [0, 0x7f, 0x80, 0xff, 65];
  let served = false;
  const relaySyscall: SyscallHook = async (call) => {
    switch (call) {
      case 'fs/stat': return { type: 'file', size: bytes.length };
      case 'fs/open': return { fd: 3 };
      case 'fs/read': {
        // First read returns the wrapped byte array; second is EOF (empty).
        if (served) return { data: [] };
        served = true;
        return { data: bytes.slice() };
      }
      case 'fs/close': return {};
      default: throw new Error(`unexpected: ${call}`);
    }
  };
  const g = guestStub(relaySyscall, '/');
  expect(Array.from(await readPath(g, '/a.bin'))).toEqual(bytes);
});

test('Q1: writePath/readPath resolve a relative path against cwd', async () => {
  const { syscall, tree } = mockFs();
  tree.set('/work', { type: 'directory' });
  const g = guestStub(syscall, '/work');
  const payload = new Uint8Array([1, 2, 3]);
  await writePath(g, 'a.bin', payload);
  // relative 'a.bin' lands at /work/a.bin
  expect(tree.get('/work/a.bin')).toMatchObject({ type: 'file' });
  expect(Array.from(await readPath(g, 'a.bin'))).toEqual([1, 2, 3]);
  // and is reachable by its absolute form
  expect(Array.from(await readPath(g, '/work/a.bin'))).toEqual([1, 2, 3]);
});

test('Q1: writePath creates intermediate directories for a deep path', async () => {
  const { syscall, tree } = mockFs();
  const g = guestStub(syscall, '/');
  await writePath(g, '/x/y/z.bin', new Uint8Array([9]));
  expect(tree.get('/x')).toMatchObject({ type: 'directory' });
  expect(tree.get('/x/y')).toMatchObject({ type: 'directory' });
  expect(tree.get('/x/y/z.bin')).toMatchObject({ type: 'file' });
  expect(Array.from(await readPath(g, '/x/y/z.bin'))).toEqual([9]);
});

test('Q1: writePath resolves a relative deep path against a nested cwd', async () => {
  const { syscall, tree } = mockFs();
  tree.set('/work', { type: 'directory' });
  const g = guestStub(syscall, '/work');
  await writePath(g, 'sub/deep.bin', new Uint8Array([7, 7]));
  expect(tree.get('/work/sub')).toMatchObject({ type: 'directory' });
  expect(Array.from(await readPath(g, 'sub/deep.bin'))).toEqual([7, 7]);
});

test('Q1: writePath overwrites an existing file', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  await writePath(g, '/f.bin', new Uint8Array([1, 2, 3, 4]));
  await writePath(g, '/f.bin', new Uint8Array([9]));
  expect(Array.from(await readPath(g, '/f.bin'))).toEqual([9]);
});

test('Q1: writePath/readPath handle an empty payload', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  await writePath(g, '/empty.bin', new Uint8Array());
  expect(Array.from(await readPath(g, '/empty.bin'))).toEqual([]);
});

test('Q1: readPath on a missing file rejects (NotFoundError)', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  await expect(readPath(g, '/nope.bin')).rejects.toMatchObject({ name: 'NotFoundError' });
});

test('Q1: readPath through a missing directory rejects (NotFoundError)', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  await expect(readPath(g, '/no/such/dir/file.bin')).rejects.toMatchObject({ name: 'NotFoundError' });
});

test('Q1: readPath normalizes . and .. and redundant slashes', async () => {
  const { syscall, tree } = mockFs();
  tree.set('/work', { type: 'directory' });
  const g = guestStub(syscall, '/work');
  await writePath(g, '/work/a.bin', new Uint8Array([42]));
  expect(Array.from(await readPath(g, './a.bin'))).toEqual([42]);
  expect(Array.from(await readPath(g, '../work/a.bin'))).toEqual([42]);
  expect(Array.from(await readPath(g, '/work//a.bin'))).toEqual([42]);
});

test('Q1: writePath rejects a path that resolves to no file name', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  await expect(writePath(g, '/', new Uint8Array([1]))).rejects.toBeInstanceOf(TypeError);
});

test('Q1: roundtrip larger-than-one-chunk bytes (binary fidelity)', async () => {
  const { syscall } = mockFs();
  const g = guestStub(syscall, '/');
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  await writePath(g, '/big.bin', big);
  const back = await readPath(g, '/big.bin');
  expect(back.byteLength).toBe(big.byteLength);
  expect(back).toEqual(big);
});
