/**
 * Task V7 (RFC 0001 §10) — the load-bearing correctness test: an MB-scale,
 * byte-exact binary round-trip through the whole Lab data path.
 *
 * ~4 MiB of pseudo-random bytes are ingested host-`File` -> VFS ({@link ingestFile}),
 * run through `copy SRC DST` spawned BY BARE NAME (resolved on `PATH` to the
 * `/usr/bin/copy` executable the Lab installs at boot, with its `security.capability`
 * xattr), then read back out VFS -> host-`Blob` ({@link readVfsToBlob}). The bytes
 * move ENTIRELY by VFS path-arg — ingest writes the path, `copy` reads/writes the
 * path, download reads the path — never the string-typed shell stdout/redirect.
 * The contract: what comes out is byte-identical to what went in.
 *
 * Browser-only: the Lab's `WorkerRuntime` eval-runs guest SOURCE and the path is
 * exercised end-to-end over the real `File`/`Blob` host surface.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';
import { ingestFile } from './ingest.ts';
import { readVfsToBlob } from './download.ts';

let lab: Lab | undefined;

afterEach(() => {
  lab?.dispose();
  lab = undefined;
});

const T = 30000;

/** The parent grant `copy` is narrowed against (it carries its own xattr grant). */
const PARENT_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const, 'execute' as const] },
  { type: 'process' as const, maxChildren: 16 },
];

/**
 * Deterministic pseudo-random bytes (xorshift) — full 0..255 coverage so any
 * byte-mangling (sign, UTF-8 re-encode, offset slip) in the path surfaces. Mirror
 * of the generator in `ingest.browser.test.ts`.
 */
function pseudoRandom(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(n));
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** Spawn `copy SRC DST` by bare name on `PATH` and wait for it to exit. */
async function runCopy(lab: Lab, src: string, dst: string): Promise<number> {
  const { pid, stdout } = await lab.kernel.spawn('copy', {
    args: ['copy', src, dst],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  return code;
}

test('~4 MiB byte-exact round-trip: File -> ingest -> copy (path-arg) -> download Blob', async () => {
  lab = await createLab({ persistStorage: null });

  const payload = pseudoRandom(4 * 1024 * 1024 + 7); // odd tail: not a 64 KiB multiple
  const file = new File([payload], 'blob.bin', { type: 'application/octet-stream' });

  const written = await ingestFile(lab.vfs, file, '/in/blob.bin');
  expect(written).toBe(payload.byteLength);

  expect(await runCopy(lab, '/in/blob.bin', '/out/blob.bin')).toBe(0);

  const blob = await readVfsToBlob(lab.vfs, '/out/blob.bin');
  expect(blob.size).toBe(payload.byteLength);

  const back = new Uint8Array(await blob.arrayBuffer());
  expect(back.byteLength).toBe(payload.byteLength);
  // Full byte-exact compare — a length match alone would miss interior corruption.
  expect(back).toEqual(payload);
}, T);

test('a zero-byte file round-trips to a zero-byte file', async () => {
  lab = await createLab({ persistStorage: null });

  const written = await ingestFile(lab.vfs, new File([], 'empty.bin'), '/in/empty.bin');
  expect(written).toBe(0);

  expect(await runCopy(lab, '/in/empty.bin', '/out/empty.bin')).toBe(0);

  const blob = await readVfsToBlob(lab.vfs, '/out/empty.bin');
  expect(blob.size).toBe(0);
}, T);

test('all 256 byte values survive the path-arg copy (no sign/encoding mangling)', async () => {
  lab = await createLab({ persistStorage: null });

  // Every byte 0..255 repeated, plus a high-bit run that a UTF-8 round-trip would
  // corrupt — the path-arg convention must keep these verbatim.
  const payload = new Uint8Array(256 * 8);
  for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
  await ingestFile(lab.vfs, new File([payload], 'bytes.bin'), '/in/bytes.bin');

  expect(await runCopy(lab, '/in/bytes.bin', '/out/bytes.bin')).toBe(0);

  const back = new Uint8Array(await (await readVfsToBlob(lab.vfs, '/out/bytes.bin')).arrayBuffer());
  expect(back).toEqual(payload);
}, T);

test('copy fails (non-zero) on a missing source and writes no output', async () => {
  lab = await createLab({ persistStorage: null });

  expect(await runCopy(lab, '/in/does-not-exist.bin', '/out/never.bin')).not.toBe(0);
  await expect(readVfsToBlob(lab.vfs, '/out/never.bin')).rejects.toBeTruthy();
}, T);
