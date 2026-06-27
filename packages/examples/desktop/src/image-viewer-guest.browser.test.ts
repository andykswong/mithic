import { afterEach, expect, test } from 'vitest';
import { IMAGE_VIEWER_GUEST } from './image-viewer-guest.ts';

// The inline guest is an ES-module SOURCE STRING (it runs inside an opaque-origin
// iframe in production, so it can't import @mithic/*). To exercise its
// display-awareness branch directly we import it as a module via a Blob URL and
// invoke its default export with a fake `boot`. The fake `boot.preopenPorts[1]`
// is a MessagePort whose peer collects the bytes the guest writes to stdout,
// decoded with the pipe credit protocol the guest's portToWritable speaks.

interface FakeBoot {
  control: MessagePort;
  init: Record<string, unknown>;
  preopenPorts: Record<number, MessagePort>;
}

/** A peer for the guest's stdout write port: grants infinite credit, collects data. */
function collectStdout(port: MessagePort): { text: () => string } {
  const chunks: Uint8Array[] = [];
  port.start();
  port.onmessage = (e: MessageEvent): void => {
    const m = e.data as { type?: string; chunk?: Uint8Array };
    if (m?.type === 'data' && m.chunk) chunks.push(new Uint8Array(m.chunk));
  };
  // Grant generous up-front credit so the guest never parks waiting for it.
  port.postMessage({ type: 'credit', bytes: 1 << 20 });
  return {
    text: () => {
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return new TextDecoder().decode(buf);
    },
  };
}

let guestUrl: string | undefined;
async function loadGuest(): Promise<(boot: FakeBoot) => Promise<void>> {
  const blob = new Blob([IMAGE_VIEWER_GUEST], { type: 'text/javascript' });
  guestUrl = URL.createObjectURL(blob);
  const mod = (await import(/* @vite-ignore */ guestUrl)) as { default: (boot: FakeBoot) => Promise<void> };
  return mod.default;
}

function makeBoot(display: unknown): { boot: FakeBoot; out: { text: () => string }; control: MessageChannel } {
  const stdioCh = new MessageChannel();
  const controlCh = new MessageChannel();
  const out = collectStdout(stdioCh.port2);
  const boot: FakeBoot = {
    control: controlCh.port1,
    init: { pid: 1, args: ['image-viewer'], env: {}, cwd: '/', display },
    preopenPorts: { 1: stdioCh.port1 },
  };
  return { boot, out, control: controlCh };
}

afterEach(() => {
  if (guestUrl) { URL.revokeObjectURL(guestUrl); guestUrl = undefined; }
  // Reset the document the guest mutated so tests don't bleed into each other.
  document.body.innerHTML = '';
});

test('image-viewer guest runs HEADLESS (no DOM) when display.available === false', async () => {
  const run = await loadGuest();
  const { boot, out, control } = makeBoot({ available: false });
  const done = run(boot);
  // Give the guest a few turns to write its marker and park on the signal.
  for (let i = 0; i < 20 && !out.text().includes('headless'); i++) await new Promise((r) => setTimeout(r, 5));
  expect(out.text()).toContain('headless');
  // No GUI surface: the drop-zone must NOT be in the document.
  expect(document.getElementById('drop-zone')).toBeNull();
  expect(document.getElementById('preview')).toBeNull();
  // Send a signal so the guest unblocks + exits cleanly.
  control.port2.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });
  await done;
});

test('image-viewer guest renders the GUI (drop-zone) when display.available === true', async () => {
  const run = await loadGuest();
  const { boot, out, control } = makeBoot({ available: true, mode: 'window', width: 800, height: 600 });
  const done = run(boot);
  for (let i = 0; i < 20 && !out.text().includes('ready'); i++) await new Promise((r) => setTimeout(r, 5));
  expect(out.text()).toContain('ready');
  expect(out.text()).not.toContain('headless');
  // GUI path: the drop-zone IS rendered.
  expect(document.getElementById('drop-zone')).not.toBeNull();
  expect(document.getElementById('preview')).not.toBeNull();
  control.port2.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });
  await done;
});

test('image-viewer guest renders the GUI when init.display is absent (no display info)', async () => {
  const run = await loadGuest();
  const { boot, out, control } = makeBoot(undefined);
  const done = run(boot);
  for (let i = 0; i < 20 && !out.text().includes('ready'); i++) await new Promise((r) => setTimeout(r, 5));
  // Absent display info is NOT an explicit "available:false", so the windowed
  // app keeps rendering (the host gave it a frame).
  expect(out.text()).toContain('ready');
  expect(document.getElementById('drop-zone')).not.toBeNull();
  control.port2.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });
  await done;
});
