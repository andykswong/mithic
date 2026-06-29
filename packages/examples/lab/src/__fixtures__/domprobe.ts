/**
 * Test fixture: a GUI utility that mounts a `<p>hello-preview</p>` under the host
 * container (node 0) via a `dom/mutate` batch, then exits. Proves `createLab`'s
 * per-pid `onDomMutate` wiring demuxes the guest's mutations to that window's
 * RemoteDomHost container (RFC 0001 §4.5).
 *
 * The first argv operand (if present) is the text to mount, so a test can assert
 * the right window received the right guest's DOM.
 *
 * Authored on `@mithic/guest-runtime` like a real utility so the `?bundle` plugin
 * produces the exec-from-VFS-runnable form the Lab installs.
 */
import { createGuest } from '@mithic/guest-runtime';

export default async (boot: unknown): Promise<void> => {
  const g = createGuest(boot as Parameters<typeof createGuest>[0]);
  const text = g.args[1] ?? 'hello-preview';
  await g.syscall('dom/mutate', {
    mutations: [
      { type: 'createElement', id: 1, tag: 'p' },
      { type: 'createText', id: 2, text },
      { type: 'appendChild', parentId: 1, childId: 2 },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ],
  });
  g.exit(0);
};
