import { afterEach, expect, test } from 'vitest';
import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { installResizeConvertWorkflow } from './workflow.ts';
import { installImageToolGuest, IMAGE_TOOL_PATH } from './guest-install.ts';
import { portToReadable } from '@mithic/guest-runtime';
import { forwardMarkers, type TelemetryEvent } from './telemetry.ts';
import { renderImageToolUI } from './guest.ts';

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

// A genuine drop test that does NOT use the MITHIC_TEST_DROP env hook (spec §3.5).
//
// The visible app guest runs in a `sandbox="allow-scripts"` opaque-origin iframe. In the
// Playwright/Chromium browser project the test realm CANNOT reach that iframe's
// `contentDocument` (it is cross-origin: `iframe.contentDocument === null`, and
// `iframe.contentWindow.DragEvent`/`DataTransfer` throw a SecurityError — verified
// empirically). So a genuine in-iframe drop cannot be dispatched from the test realm.
//
// Per the plan's documented fallback, the drop/reveal wiring is proven against the
// test's OWN document via the extracted pure-DOM `renderImageToolUI(doc, deps)` factory
// (the same factory `main(boot)` wires into the real guest). This dispatches a REAL
// `DragEvent` carrying a `DataTransfer` file at the drop zone — the primary UX path,
// not the env test-hook — and asserts the progressive-reveal order end-to-end.
test('the app guest UI processes a genuine DragEvent drop (no test-hook)', async () => {
  const events: TelemetryEvent[] = [];
  // A RIFF/WEBP-magic stub stands in for the workflow output so the reveal + preview
  // wiring is exercised without the kernel; the kernel-backed workflow is covered by
  // workflow.browser.test.ts and the funnel test above.
  const RIFF_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  let ran = 0;
  const ui = renderImageToolUI(document, {
    runWorkflow: async () => { ran++; return RIFF_WEBP; },
    emit: (name, dims) => { events.push({ name, dims: dims ?? {} }); },
  });

  try {
    // Progressive-reveal State 1 (spec §5/§8): before any drop, controls + result hidden.
    expect(document.getElementById('controls')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('result')!.classList.contains('hidden')).toBe(true);

    // Dispatch a REAL DragEvent (not the env hook) with a File on its DataTransfer.
    const png = await fixturePng(40, 20);
    // Copy into a fresh ArrayBuffer-backed view so it is statically a `BlobPart`
    // (a syscall-sourced Uint8Array may be over a SharedArrayBuffer — mirrors the
    // guest's `toBlob`). `fixturePng` returns a plain Uint8Array here, but the copy
    // satisfies the compiler and is byte-identical.
    const pngPart = new Uint8Array(png.byteLength);
    pngPart.set(png);
    const file = new File([pngPart], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const dropZone = document.getElementById('drop')!;
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    dropZone.dispatchEvent(ev);

    // Reveal step 1 (State 2): after a drop, controls become visible + file_dropped emitted.
    await expect.poll(() => events.some((e) => e.name === 'file_dropped'), { timeout: T }).toBe(true);
    await expect.poll(() => document.getElementById('controls')!.classList.contains('hidden'), { timeout: T }).toBe(false);

    // The guest doesn't auto-run on drop; the user clicks Run.
    ui.runBtn.click();

    // Reveal step 2 (State 3): after processing, the result (preview + download) is visible.
    await expect.poll(() => events.some((e) => e.name === 'processed'), { timeout: T }).toBe(true);
    await expect.poll(() => document.getElementById('result')!.classList.contains('hidden'), { timeout: T }).toBe(false);
    expect(ran).toBe(1);
    // Preview points at a blob: minted inside this realm (G6 img-src blob:).
    expect((document.getElementById('preview') as HTMLImageElement).getAttribute('src')?.startsWith('blob:')).toBe(true);
  } finally {
    ui.dispose();
    document.head.querySelector('style')?.remove();
    document.body.innerHTML = '';
  }
}, T);
