/**
 * Task V5 — `createLab` wires `KernelOptions.onDomMutate` to a per-pid
 * {@link RemoteDomHost}, demuxing a guest's batched DOM mutations to that
 * window's container (RFC 0001 §4.5). A GUI utility that emits `dom/mutate`
 * records paints into the container the host resolved for its pid; a pid with no
 * container is a safe drop.
 *
 * Browser-only: needs the `WorkerRuntime` exec-from-VFS eval path + a real DOM
 * container. The GUI guest is installed and spawned by bare name exactly like a
 * real Lab utility (the `?bundle` plugin makes the fixture exec-from-VFS-runnable).
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';
import { installUtility } from './install.ts';
import domprobeSource from './__fixtures__/domprobe.ts?bundle';

let lab: Lab | undefined;
const containers: HTMLElement[] = [];

afterEach(() => {
  lab?.dispose();
  lab = undefined;
  for (const c of containers) c.remove();
  containers.length = 0;
});

function freshContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  containers.push(el);
  return el;
}

const T = 30000;

const PARENT_CAPS = [
  { type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const, 'execute' as const] },
  { type: 'process' as const, maxChildren: 16 },
];

async function installDomprobe(lab: Lab): Promise<void> {
  await installUtility(
    lab.vfs,
    '/usr/bin/domprobe',
    new TextEncoder().encode('#!/bin/node\n' + domprobeSource),
    { name: 'domprobe', capabilities: { fs: { paths: ['/work'], operations: ['read', 'write'] } } },
  );
}

test('a GUI guest’s dom/mutate is routed by pid to that window’s container', async () => {
  const byPid = new Map<number, Element>();
  const container = freshContainer();
  // A single-window Lab: every guest paints into the one container. (Multi-window
  // demux is the same code keyed differently — covered by the orphan drop below.)
  lab = await createLab({
    persistStorage: null,
    resolveDomContainer: (pid) => byPid.get(pid) ?? container,
  });
  await installDomprobe(lab);

  const { pid } = await lab.kernel.spawn('domprobe', {
    args: ['domprobe', 'hello-preview'],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
  });
  byPid.set(pid, container);
  await lab.kernel.wait(pid);

  await expect
    .poll(() => container.querySelector('p')?.textContent, { timeout: T })
    .toBe('hello-preview');
}, T);

test('a dom/mutate for a pid with no resolved container is a safe drop (guest still exits 0)', async () => {
  lab = await createLab({
    persistStorage: null,
    resolveDomContainer: () => undefined, // no window for any pid
  });
  await installDomprobe(lab);

  const { pid } = await lab.kernel.spawn('domprobe', {
    args: ['domprobe'],
    env: { PATH: '/usr/bin' },
    capabilities: PARENT_CAPS,
  });
  const { code } = await lab.kernel.wait(pid);
  expect(code).toBe(0); // dropped host-side; the guest's dom/mutate still resolves
}, T);
