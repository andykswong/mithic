/**
 * Task V2 (the load-bearing proof): a utility authored as a `defineCommand`
 * bundle, installed into `/usr/bin` with its manifest's caps in the file's
 * `security.capability` xattr, actually RUNS via exec-from-VFS by BARE NAME on
 * `PATH=/usr/bin` — and the capability model holds (an undeclared `net` is
 * denied; `getcap` shows the granted caps).
 *
 * Why a browser test: the Lab's `WorkerRuntime` eval-runs guest SOURCE (it does
 * not `import()` a module URL). A bare `@mithic/guest-runtime` import or an ESM
 * `export default` in the installed source would not run there — so this proves
 * the *bundled* (deps-inlined, `globalThis.__mithic_default`-assigning) form the
 * Lab installs is genuinely exec-from-VFS runnable, not just node-importable.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';
import { installUtility } from './install.ts';
import netprobeSource from './__fixtures__/netprobe.ts?bundle';

let lab: Lab | undefined;

afterEach(() => {
  lab?.dispose();
  lab = undefined;
});

const T = 30000;

/** A tiny PNG (any decodable image) generated in-test via OffscreenCanvas. */
async function fixturePng(width = 8, height = 8): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
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

/** The parent grant the Lab's installed utilities are narrowed against. */
const PARENT_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const, 'execute' as const] },
  { type: 'process' as const, maxChildren: 16 },
];

test('an installed `imgresize` bundle runs via exec-from-VFS by bare name on PATH', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/x.png', await fixturePng(40, 20));

  const { pid, stdout } = await lab.kernel.spawn('imgresize', {
    args: ['imgresize', '/in/x.png', '/out/x.webp'],
    env: { PATH: '/usr/bin', WIDTH: '16' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout; // drain
  expect(code).toBe(0);

  const out = await readVfs(lab, '/out/x.webp');
  expect(out.byteLength).toBeGreaterThan(0);
  const bmp = await createImageBitmap(new Blob([out.slice()]));
  expect(bmp.width).toBe(16);
  bmp.close();
}, T);

test('the kernel DENIES an undeclared capability (net) to an installed utility', async () => {
  lab = await createLab({ persistStorage: null });

  // `netprobe` is installed with a manifest granting only fs (no net). It tries
  // a net/fetch and writes the denial errno to its output path.
  await installUtility(
    lab.vfs,
    '/usr/bin/netprobe',
    new TextEncoder().encode('#!/bin/node\n' + netprobeSource),
    { name: 'netprobe', capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] } } },
  );

  const { pid, stdout } = await lab.kernel.spawn('netprobe', {
    args: ['netprobe'],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const code = (await lab.kernel.wait(pid)).code;
  const result = new TextDecoder().decode(await stdout!);
  expect(code).toBe(0);
  expect(result).toContain('NET-DENIED');
  expect(result).toContain('EACCES');
}, T);

test('getcap shows the installed utility its manifest-sourced grant', async () => {
  lab = await createLab({ persistStorage: null });
  const out = await lab.run('getcap /usr/bin/imgresize');
  // imgresize's manifest grants fs read+write on /in,/out,/work.
  expect(out).toContain('/usr/bin/imgresize');
  expect(out).toContain('fs:read,write:/in,/out,/work');
}, T);

test('a text utility (csvcols) also runs via exec-from-VFS by bare name', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/data.csv', new TextEncoder().encode('a,b,c\n1,2,3\n4,5,6\n'));

  const { pid, stdout } = await lab.kernel.spawn('csvcols', {
    args: ['csvcols', '/in/data.csv', '/out/data.csv'],
    env: { PATH: '/usr/bin', COLS: 'a,c' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await readVfs(lab, '/out/data.csv'))).toBe('a,c\n1,3\n4,6\n');
}, T);

test('every declared utility is installed +x with its manifest caps in xattr', async () => {
  lab = await createLab({ persistStorage: null });
  for (const name of ['copy', 'csvcols', 'imgresize', 'imgconvert']) {
    const st = await lab.vfs.stat(`/usr/bin/${name}`);
    expect(st.type).toBe('file');
    expect(st.mode & 0o111).not.toBe(0);
    const out = await lab.run(`getcap /usr/bin/${name}`);
    expect(out).toContain('fs:read,write:/in,/out,/work');
  }
}, T);

test('the installed bytes carry the #!/bin/node shebang the exec path strips', async () => {
  lab = await createLab({ persistStorage: null });
  const bytes = await readVfs(lab, '/usr/bin/copy');
  expect(new TextDecoder().decode(bytes.subarray(0, 11))).toBe('#!/bin/node');
}, T);
