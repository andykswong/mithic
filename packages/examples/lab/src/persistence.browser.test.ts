/**
 * Task V6 (RFC 0001 §4.6): the saved workflow + its installed utilities' caps
 * survive a reload and re-run DETERMINISTICALLY.
 *
 * The Lab mounts an `OPFSProvider` on `/persist` (the persistent tree). When a
 * utility is installed and a workflow saved THERE, both the bytes and — the
 * load-bearing part — the file's `security.capability` xattr ride the per-mount
 * metadata store (Phase P3) across a fresh `OPFSProvider` over the same root. We
 * simulate a reload by building a second `createLab` over the SAME injected OPFS
 * storage, then assert: `getcap` still reports the utility's grant, and running
 * the persisted workflow on the same seeded input — before and after the reload —
 * yields byte-identical output.
 *
 * Browser-only: OPFS + the Worker runtime that eval-runs guest SOURCE.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';
import { installUtility } from './install.ts';
import csvcolsSource from '../../../coreutils/src/commands/csvcols.ts?bundle';

let labs: Lab[] = [];

afterEach(() => {
  for (const lab of labs) lab.dispose();
  labs = [];
});

const T = 30000;

/** A storage manager pinned to a single fresh OPFS subdirectory: two `createLab`s
 *  over it share the same backing root, so the second simulates a page reload. */
async function sharedPersistStorage(): Promise<{ getDirectory: () => Promise<FileSystemDirectoryHandle> }> {
  const root = await navigator.storage.getDirectory();
  const sub = await root.getDirectoryHandle(
    `lab-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    { create: true },
  );
  return { getDirectory: async () => sub };
}

async function boot(persistStorage: { getDirectory: () => Promise<FileSystemDirectoryHandle> }): Promise<Lab> {
  const lab = await createLab({ persistStorage });
  labs.push(lab);
  return lab;
}

async function seed(lab: Lab, path: string, bytes: Uint8Array): Promise<void> {
  const h = await lab.vfs.open(path, { write: true, create: true, truncate: true });
  await lab.vfs.write(h, bytes, 0);
  await lab.vfs.close(h);
}

async function readVfs(lab: Lab, path: string): Promise<Uint8Array> {
  const h = await lab.vfs.open(path, { read: true });
  const chunks: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const c = await lab.vfs.read(h, off, 65536);
    if (!c || c.byteLength === 0) break;
    chunks.push(new Uint8Array(c));
    off += c.byteLength;
  }
  await lab.vfs.close(h);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** Lay down the persistent tree: a `csvcols` utility + a workflow that calls it,
 *  both in `/persist/bin`, plus the seeded input in `/persist/in`. */
async function setupPersistentTree(lab: Lab): Promise<void> {
  for (const dir of ['/persist/bin', '/persist/in', '/persist/out']) {
    try { await lab.vfs.mkdir(dir); } catch { /* already exists */ }
  }

  await installUtility(
    lab.vfs,
    '/persist/bin/csvcols',
    new TextEncoder().encode('#!/bin/node\n' + csvcolsSource),
    { name: 'csvcols', capabilities: { fs: { paths: ['/persist'], operations: ['read', 'write'] } } },
  );

  // The workflow is itself a `#!/bin/bash` executable that chains a utility by
  // name on PATH — the saved `.sh` of RFC §4.3.
  await installUtility(
    lab.vfs,
    '/persist/bin/extract.sh',
    new TextEncoder().encode('#!/bin/bash\nset -euo pipefail\nCOLS="${COLS:-a,c}" csvcols "$1" "$2"\n'),
    { name: 'extract.sh', capabilities: { fs: { paths: ['/persist'], operations: ['read', 'write'] }, process: { maxChildren: 16 } } },
  );

  await seed(lab, '/persist/in/data.csv', new TextEncoder().encode('a,b,c\n1,2,3\n4,5,6\n'));
}

const PARENT_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const, 'execute' as const] },
  { type: 'process' as const, maxChildren: 16 },
];

/** Run the persisted workflow once, returning the output bytes. */
async function runWorkflow(lab: Lab, outPath: string): Promise<Uint8Array> {
  const { pid, stdout } = await lab.kernel.spawn('extract.sh', {
    args: ['extract.sh', '/persist/in/data.csv', outPath],
    env: { PATH: '/persist/bin', COLS: 'a,c' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).toBe(0);
  return readVfs(lab, outPath);
}

test('a workflow + its utility caps persist to OPFS and re-run byte-identically after reload', async () => {
  const storage = await sharedPersistStorage();

  // First session: install + save into the persistent tree, then run once.
  const first = await boot(storage);
  await setupPersistentTree(first);

  const beforeCaps = await first.run('getcap /persist/bin/csvcols');
  expect(beforeCaps).toContain('/persist/bin/csvcols');
  expect(beforeCaps).toContain('fs:read,write:/persist');

  const out1 = await runWorkflow(first, '/persist/out/run1.csv');
  expect(new TextDecoder().decode(out1)).toBe('a,c\n1,3\n4,6\n');

  // Simulate a reload: a brand-new Lab over the SAME OPFS root. The utility bytes,
  // its `+x`, its `security.capability` xattr, and the workflow are all gone from
  // memory but must be recovered from OPFS + the metadata store.
  const second = await boot(storage);

  // The persisted files came back...
  expect((await second.vfs.stat('/persist/bin/csvcols')).type).toBe('file');
  expect((await second.vfs.stat('/persist/bin/extract.sh')).type).toBe('file');

  // ...with their xattr caps intact (the load-bearing P3 persistence claim).
  const afterCaps = await second.run('getcap /persist/bin/csvcols');
  expect(afterCaps).toContain('fs:read,write:/persist');
  expect(afterCaps).toBe(beforeCaps);

  // ...and re-run deterministically: byte-identical to the pre-reload output.
  const out2 = await runWorkflow(second, '/persist/out/run2.csv');
  expect(out2.byteLength).toBe(out1.byteLength);
  expect(Array.from(out2)).toEqual(Array.from(out1));
}, T);

test('the persisted utility keeps its execute bit (it is exec-from-VFS runnable after reload)', async () => {
  const storage = await sharedPersistStorage();

  const first = await boot(storage);
  await setupPersistentTree(first);
  expect((await first.vfs.stat('/persist/bin/csvcols')).mode & 0o111).not.toBe(0);

  const second = await boot(storage);
  const st = await second.vfs.stat('/persist/bin/csvcols');
  expect(st.mode & 0o111).not.toBe(0);
}, T);

test('re-running the workflow twice within one session is also deterministic', async () => {
  const storage = await sharedPersistStorage();
  const lab = await boot(storage);
  await setupPersistentTree(lab);

  const a = await runWorkflow(lab, '/persist/out/a.csv');
  const b = await runWorkflow(lab, '/persist/out/b.csv');
  expect(Array.from(b)).toEqual(Array.from(a));
}, T);
