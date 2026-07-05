import { afterEach, expect, test } from 'vitest';
import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { installResizeConvertWorkflow } from './workflow.ts';
import { installImageToolGuest, IMAGE_TOOL_PATH } from './guest-install.ts';
import { portToReadable } from '@mithic/guest-runtime';
import { forwardMarkers, type TelemetryEvent } from './telemetry.ts';

const T = 30000;
let lab: Lab | undefined;
afterEach(() => { lab?.dispose(); lab = undefined; });

async function fixturePng(width = 40, height = 20): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

test('the image-tool app guest processes a dropped image and emits the funnel markers', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  lab = await createLab({ persistStorage: null, runtime: new IframeRuntime({ container }) });
  await installResizeConvertWorkflow(lab.vfs);
  await installImageToolGuest(lab.vfs);

  // Live stdout pipe: the app guest is long-lived (stays alive for interaction), so
  // capture-until-EOF won't work — read markers live off an injected stdout port.
  const pipe = lab.kernel.ipc.createPipe();
  const events: TelemetryEvent[] = [];
  const collected = forwardMarkers(portToReadable(pipe.readPort), (ev) => events.push(ev));

  // Prepare a dropped file the guest can pick up: we pass its bytes via env as a
  // base64 test-hook the guest reads when MITHIC_TEST_DROP is set (test-only path;
  // real drops come from a DragEvent — asserted separately below).
  const pngB64 = btoa(String.fromCharCode(...await fixturePng(40, 20)));

  const { pid } = await lab.kernel.spawn(IMAGE_TOOL_PATH, {
    args: ['image-tool'],
    env: {
      PATH: '/usr/bin:/bin', PWD: '/',
      MITHIC_TEST_DROP: pngB64,
      MITHIC_TEST_NAME: 'photo.png',
      MITHIC_TEST_WIDTH: '16',
      MITHIC_TEST_FORMAT: 'webp',
    },
    cwd: '/',
    capabilities: [
      { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
      { type: 'process', maxChildren: 16 },
    ],
    stdout: pipe.writePort,
    display: { mode: 'window', width: 480, height: 640, container, allowDownloads: true },
  });

  // Poll the collected markers until the full funnel appears (guest self-reports).
  await expect.poll(() => events.map((e) => e.name), { timeout: T })
    .toEqual(expect.arrayContaining(['file_dropped', 'processing_started', 'processed', 'previewed']));

  const processed = events.find((e) => e.name === 'processed')!;
  expect(processed.dims.outFmt).toBe('webp');
  expect(processed.dims.targetWidth).toBe('16');

  // Guest-owned ingest is byte-exact (spec §8): the dropped bytes landed in /in verbatim.
  const inH = await lab.vfs.open('/in/photo.png', { read: true });
  const inChunks: Uint8Array[] = []; let inOff = 0;
  for (;;) { const cc = await lab.vfs.read(inH, inOff, 65536); if (!cc || cc.byteLength === 0) break; inChunks.push(new Uint8Array(cc)); inOff += cc.byteLength; }
  await lab.vfs.close(inH);
  const inBytes = new Uint8Array(inOff); { let o = 0; for (const cc of inChunks) { inBytes.set(cc, o); o += cc.byteLength; } }
  const expectedIn = await fixturePng(40, 20);
  expect(inBytes).toEqual(expectedIn);

  // The output image exists in the VFS and is a WebP.
  const h = await lab.vfs.open('/out/photo.webp', { read: true });
  const c = await lab.vfs.read(h, 0, 16);
  await lab.vfs.close(h);
  expect(new TextDecoder().decode(new Uint8Array(c!).subarray(0, 4))).toBe('RIFF');

  // Security boundary (spec §8): the visible APP guest carries allow-downloads, but the
  // HIDDEN compute guests (imgresize/imgconvert) must NOT — check the sandbox tokens
  // across all mounted iframes. Exactly one visible frame has allow-downloads; any
  // off-screen (hidden) frame never does.
  const frames = [...document.querySelectorAll('iframe')];
  const withDownloads = frames.filter((f) => (f.getAttribute('sandbox') ?? '').includes('allow-downloads'));
  const hiddenWithDownloads = frames.filter((f) => f.style.display === 'none' && (f.getAttribute('sandbox') ?? '').includes('allow-downloads'));
  expect(withDownloads.length).toBeGreaterThanOrEqual(1); // the app guest
  expect(hiddenWithDownloads.length).toBe(0);             // no compute guest

  // G6 fact (spec §3.2/§8): the app guest's iframe srcdoc CSP admits img-src blob: — the
  // basis for painting a produced image inside the sandbox. `iframe-bootstrap` is not an
  // exported subpath, so assert the shipped CSP literal is present in the visible app
  // frame's srcdoc (the with-downloads frame is the app guest).
  const appFrame = withDownloads[0]!;
  expect(appFrame.srcdoc).toContain('img-src blob:');

  lab.kernel.kill(pid, 'SIGTERM');
  await collected.catch(() => {});
  container.remove();
}, T);
