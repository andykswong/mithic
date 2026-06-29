/**
 * Task V4 (RFC 0001 §4.3): a WORKFLOW is just a `#!/bin/bash` script that chains
 * ≥2 utility executables by PATH-ARGS. The bytes (an image) move from `/in` →
 * `/work` → `/out` entirely through `fs/*` path arguments — never through the
 * shell's string-typed stdout/redirect — so binary survives the chain.
 *
 * The load-bearing wiring this proves: a `#!/bin/bash` file spawned by bare name
 * dispatches through the kernel's exec-from-VFS shebang path to the `@mithic/shell`
 * guest installed at `/bin/bash`, which then resolves and spawns the workflow's
 * own utility steps (`imgresize`, `imgconvert`) by name on `PATH`. Composition is
 * the shell, all the way down.
 *
 * Browser-only: the Lab's `WorkerRuntime` eval-runs guest SOURCE and the image
 * utilities need `OffscreenCanvas`/`createImageBitmap`.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';
import { installUtility } from './install.ts';

let lab: Lab | undefined;

afterEach(() => {
  lab?.dispose();
  lab = undefined;
});

const T = 30000;

/** The parent grant the workflow + its children are narrowed against. */
const PARENT_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const, 'execute' as const] },
  { type: 'process' as const, maxChildren: 16 },
];

/** A decodable PNG generated in-test via OffscreenCanvas. */
async function fixturePng(width = 40, height = 20): Promise<Uint8Array> {
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

/** Install a `#!/bin/bash` workflow as an executable (its grant inherited from the parent). */
async function installWorkflow(lab: Lab, path: string, script: string): Promise<void> {
  await installUtility(
    lab.vfs,
    path,
    new TextEncoder().encode(`#!/bin/bash\n${script}`),
    { name: path.slice(path.lastIndexOf('/') + 1), capabilities: { fs: { paths: ['/in', '/out', '/work'], operations: ['read', 'write'] }, process: { maxChildren: 16 } } },
  );
}

test('a #!/bin/bash workflow chains imgresize -> imgconvert by path-args (binary survives)', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));

  await installWorkflow(
    lab,
    '/usr/bin/resize-and-convert',
    'set -euo pipefail\nWIDTH="${WIDTH:-16}" imgresize "$1" /work/a.webp\nimgconvert /work/a.webp "$2"\n',
  );

  const { pid, stdout } = await lab.kernel.spawn('resize-and-convert', {
    args: ['resize-and-convert', '/in/photo.png', '/out/photo.jpeg'],
    env: { PATH: '/usr/bin', WIDTH: '16' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).toBe(0);

  // The chained binary survived the path-arg pipeline: a valid JPEG (SOI 0xFF 0xD8).
  const out = await readVfs(lab, '/out/photo.jpeg');
  expect(out.byteLength).toBeGreaterThan(0);
  expect(out[0]).toBe(0xff);
  expect(out[1]).toBe(0xd8);

  // And it really went through the resize step: the intermediate /work/a.webp
  // decodes to the requested WIDTH.
  const inter = await readVfs(lab, '/work/a.webp');
  const bmp = await createImageBitmap(new Blob([inter.slice()]));
  expect(bmp.width).toBe(16);
  bmp.close();
}, T);

test('a workflow is itself an executable: another script can call it by name', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));

  await installWorkflow(
    lab,
    '/usr/bin/inner',
    'set -euo pipefail\nWIDTH=16 imgresize "$1" "$2"\n',
  );
  // `outer` calls `inner` by bare name — composition is the shell all the way down.
  await installWorkflow(
    lab,
    '/usr/bin/outer',
    'set -euo pipefail\ninner "$1" /work/b.webp\nimgconvert /work/b.webp "$2"\n',
  );

  const { pid, stdout } = await lab.kernel.spawn('outer', {
    args: ['outer', '/in/photo.png', '/out/out.png'],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).toBe(0);

  const out = await readVfs(lab, '/out/out.png');
  // PNG magic.
  expect(Array.from(out.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
}, T);

test('a bare-name utility spawned FROM a workflow runs with its manifest-narrowed caps, not the parent shell grant (FIX-A)', async () => {
  // FIX-A regression (RFC-1/§4.2/§4.8, D7). This drives the kernel's *syscall* spawn
  // path (`process/spawn` issued by the running shell guest), which is the Lab's
  // PRIMARY bare-name-in-a-workflow path and the one that was inverted: the
  // dispatcher's #resolveCode consulted the in-process registry FIRST. Because
  // `copy` is ALSO a registry command, the old order resolved it to the registry
  // sentinel — the kernel never read /usr/bin/copy's `security.capability` xattr, so
  // the child ran with the SHELL parent's broad fs-write on '/' and the escape write
  // to /etc SUCCEEDED (the §4.8 "caps live in the file" promise silently defeated).
  //
  // With $PATH→VFS-file winning, `copy` resolves to /usr/bin/copy, the kernel reads
  // its xattr (granted /in,/out,/work only) and narrows the child to it — so the
  // write to /etc is DENIED (EACCES → non-zero exit) even though the workflow's
  // shell parent holds fs-write on all of '/'.
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/secret.txt', new TextEncoder().encode('topsecret'));

  await installWorkflow(
    lab,
    '/usr/bin/escape',
    // `copy` is a bare name resolved on PATH by the shell's process/spawn syscall.
    'copy "$1" /etc/escape.txt\n',
  );

  const { pid, stdout } = await lab.kernel.spawn('escape', {
    args: ['escape', '/in/secret.txt'],
    // The SHELL parent (and thus the spawning context) holds fs-write on ALL of '/'.
    env: { PATH: '/usr/bin', PWD: '/' },
    cwd: '/',
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;

  // The inode xattr grant (no '/etc') governs the child, not the parent's '/'.
  expect(code).not.toBe(0);
  await expect(readVfs(lab, '/etc/escape.txt')).rejects.toBeTruthy();

  // PATH-first must NOT have broken running the installed utility: the SAME `copy`,
  // by bare name from a workflow, still succeeds WITHIN its grant (and the manifest
  // xattr is what governs — it is only narrowed, never failed to launch).
  await installWorkflow(lab, '/usr/bin/inbounds', 'copy "$1" /work/copy.txt\n');
  const ok = await lab.kernel.spawn('inbounds', {
    args: ['inbounds', '/in/secret.txt'],
    env: { PATH: '/usr/bin', PWD: '/' },
    cwd: '/',
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const okWait = await lab.kernel.wait(ok.pid);
  if (ok.stdout) await ok.stdout;
  expect(okWait.code).toBe(0);
  expect(new TextDecoder().decode(await readVfs(lab, '/work/copy.txt'))).toBe('topsecret');
}, T);

test('set -e aborts the workflow on a failing stage (non-zero exit)', async () => {
  lab = await createLab({ persistStorage: null });
  await seed(lab, '/in/photo.png', await fixturePng(40, 20));

  // The first stage fails (no such input); `set -e` must abort before the second.
  await installWorkflow(
    lab,
    '/usr/bin/will-fail',
    'set -euo pipefail\nWIDTH=16 imgresize /in/does-not-exist.png /work/a.webp\nimgconvert /work/a.webp "$1"\n',
  );

  const { pid, stdout } = await lab.kernel.spawn('will-fail', {
    args: ['will-fail', '/out/never.jpeg'],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
    captureStdout: true,
    captureStderr: true,
  });
  const { code } = await lab.kernel.wait(pid);
  if (stdout) await stdout;
  expect(code).not.toBe(0);

  // The aborted second stage never ran, so the output was never written.
  await expect(readVfs(lab, '/out/never.jpeg')).rejects.toBeTruthy();
}, T);
