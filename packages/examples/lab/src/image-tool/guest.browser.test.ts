import { afterEach, expect, test, vi } from 'vitest';
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

/** A genuinely-decodable image so the preview <img> fires its `load` event (drives 'rendered'). */
async function fixtureImage(type: string, width = 32, height = 16): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#a6e3a1';
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type });
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

  // Poll the collected markers until the full funnel appears (guest self-reports). The
  // 'rendered' marker fires from the preview <img> LOAD event — proof (G6) the produced
  // blob: image actually DECODED AND PAINTED inside the opaque iframe under the shipped
  // CSP, not merely that output bytes exist (spec §8: self-reports rendered/ready).
  await expect.poll(() => events.map((e) => e.name), { timeout: T })
    .toEqual(expect.arrayContaining(['file_dropped', 'processing_started', 'processed', 'previewed', 'rendered']));

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
  // A genuinely-decodable JPEG stands in for the workflow output so the preview <img>
  // actually decodes + fires its `load` event (the basis for the 'rendered' marker),
  // exercising the reveal + preview wiring without the kernel; the kernel-backed
  // workflow is covered by workflow.browser.test.ts and the funnel test above.
  const outImage = await fixtureImage('image/jpeg');
  let ran = 0;
  const ui = renderImageToolUI(document, {
    runWorkflow: async () => { ran++; return outImage; },
    emit: (name, dims) => { events.push({ name, dims: dims ?? {} }); },
  });

  try {
    // Progressive-reveal State 1 (spec §5/§8): before any drop, controls + result hidden.
    expect(document.getElementById('controls')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('result')!.classList.contains('hidden')).toBe(true);

    // Mobile/reveal structural invariant (spec §8): the core layout is single-column —
    // the top-level UI sections stack in normal block flow (body is not a grid/flex row),
    // so on a narrow viewport controls/preview/download read top-to-bottom (not
    // pixel-perfect — a structural guard against a regression to a multi-column layout).
    const bodyDisplay = window.getComputedStyle(document.body).display;
    expect(bodyDisplay === 'block' || bodyDisplay === 'flow-root').toBe(true);
    expect(window.getComputedStyle(document.body).gridTemplateColumns).toBe('none');
    expect(document.body.querySelector('[style*="grid-template-columns"]')).toBeNull();

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

    // The file_dropped marker carries the parsed source format dimension (spec §5).
    const fileDrop = events.find((e) => e.name === 'file_dropped');
    expect(fileDrop?.dims.inFmt).toBe('png');

    // Drive the primary UX controls before Run: pick a format via the format buttons and a
    // width via the number input (the source is 40px, so pick a value within range — the UI
    // clamps to source width, no upscale). These are the real controls, not the env hook.
    const jpegBtn = [...document.querySelectorAll('#fmts .fmt')].find((b) => (b as HTMLElement).dataset.f === 'jpeg') as HTMLButtonElement;
    jpegBtn.click();
    const wnum = document.getElementById('wnum') as HTMLInputElement;
    wnum.value = '32';
    wnum.dispatchEvent(new Event('input', { bubbles: true }));

    // The guest doesn't auto-run on drop; the user clicks Run.
    ui.runBtn.click();

    // Reveal step 2 (State 3): after processing, the result (preview + download) is visible.
    await expect.poll(() => events.some((e) => e.name === 'processed'), { timeout: T }).toBe(true);
    await expect.poll(() => document.getElementById('result')!.classList.contains('hidden'), { timeout: T }).toBe(false);
    expect(ran).toBe(1);

    // The processed marker reflects the format/width chosen through the UI controls above.
    const processed = events.find((e) => e.name === 'processed');
    expect(processed?.dims.outFmt).toBe('jpeg');
    expect(processed?.dims.targetWidth).toBe('32');

    // Preview points at a blob: minted inside this realm (G6 img-src blob:).
    expect((document.getElementById('preview') as HTMLImageElement).getAttribute('src')?.startsWith('blob:')).toBe(true);

    // State 3 post-render (spec §5): the 'previewed' marker fires after `preview.src` is
    // assigned. The 'rendered' marker fires LATER, from the <img> load event — confirming
    // the produced blob: image actually DECODED AND PAINTED (spec §8: self-reports
    // rendered/ready), not merely that `src` was set. It carries the output format.
    await expect.poll(() => events.some((e) => e.name === 'previewed'), { timeout: T }).toBe(true);
    await expect.poll(() => events.some((e) => e.name === 'rendered'), { timeout: T }).toBe(true);
    expect(events.find((e) => e.name === 'rendered')?.dims.outFmt).toBe('jpeg');
  } finally {
    ui.dispose();
    document.head.querySelector('style')?.remove();
    document.body.innerHTML = '';
  }
}, T);

// Error path (spec §5): when the workflow fails (throws / non-zero exit surfaced as a
// thrown Error by the guest's runWorkflow), the catch block must reveal the result div
// with an error message and emit `process_error` carrying the error's `errorClass`. The
// funnel/DragEvent tests only cover the happy path; this pins the failure branch in the
// same pure-DOM context (the extracted `renderImageToolUI` factory `main(boot)` wires).
test('the app guest UI reveals an error state and emits process_error when the workflow fails', async () => {
  const events: TelemetryEvent[] = [];
  class WorkflowError extends Error { override name = 'WorkflowError'; }
  const ui = renderImageToolUI(document, {
    runWorkflow: async () => { throw new WorkflowError('workflow exited 1'); },
    emit: (name, dims) => { events.push({ name, dims: dims ?? {} }); },
  });

  try {
    // Before any run, the result div is hidden.
    expect(document.getElementById('result')!.classList.contains('hidden')).toBe(true);

    // Load a source so runBtn has bytes to act on, then click Run — the injected
    // runWorkflow throws, driving the catch block.
    await ui.loadFile(await fixturePng(40, 20), 'shot.png');
    ui.runBtn.click();

    // The error is surfaced: process_error fires with the thrown error's class as errorClass.
    await expect.poll(() => events.some((e) => e.name === 'process_error'), { timeout: T }).toBe(true);
    const err = events.find((e) => e.name === 'process_error');
    expect(err?.dims.errorClass).toBe('WorkflowError');

    // The result div is revealed carrying the error message (progressive-reveal to State 3-error).
    await expect.poll(() => document.getElementById('result')!.classList.contains('hidden'), { timeout: T }).toBe(false);
    expect(document.getElementById('resultmsg')!.textContent).toContain('error: workflow exited 1');

    // The happy-path markers never fired — the failure short-circuited before preview.
    expect(events.some((e) => e.name === 'processed')).toBe(false);
    expect(events.some((e) => e.name === 'previewed')).toBe(false);

    // The Run button is re-enabled by the finally block so the user can retry.
    expect(ui.runBtn.disabled).toBe(false);
  } finally {
    ui.dispose();
    document.head.querySelector('style')?.remove();
    document.body.innerHTML = '';
  }
}, T);

// Download interaction (spec §5, Task 6 `downloaded` marker): after a successful run the
// download button is wired to mint an <a download> and click it, and emit `downloaded`
// with the output format. The funnel test stops at `previewed`; this exercises the user
// clicking Download and asserts the marker fires with its `outFmt` dimension.
//
// The `emit` stub here is ASYNC (it settles the event on a later microtask, like the real
// guest's `writer.write(...)` returning a Promise). The download handler MUST `await emit`
// so the monotonic 'downloaded' marker is not dropped if the guest is signalled/exits
// right after the click — a synchronous handler would let the write race the teardown.
test('the app guest UI emits the downloaded marker with outFmt when the download button is clicked', async () => {
  const events: TelemetryEvent[] = [];
  const RIFF_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const emitCalls: Array<Promise<void>> = [];
  const ui = renderImageToolUI(document, {
    runWorkflow: async () => RIFF_WEBP,
    // Async emit: record the event only after a microtask so a non-awaited caller would
    // lose ordering/delivery. The awaited handlers make the marker deterministic.
    emit: (name, dims) => {
      const p = Promise.resolve().then(() => { events.push({ name, dims: dims ?? {} }); });
      emitCalls.push(p);
      return p;
    },
  });

  // The anchor click() in the download handler would open a navigation in the test realm;
  // intercept it so the assertion targets only the marker + anchor wiring.
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    // Complete a run so the result (with the download button) is shown and the handler wired.
    await ui.loadFile(await fixturePng(40, 20), 'shot.png');
    ui.runBtn.click();
    await expect.poll(() => events.some((e) => e.name === 'previewed'), { timeout: T }).toBe(true);

    // The user clicks Download.
    (document.getElementById('download') as HTMLButtonElement).click();

    // The `downloaded` marker fires with the chosen output format (default webp). The
    // handler awaited the async emit, so the marker is delivered (not lost to a race).
    await expect.poll(() => events.some((e) => e.name === 'downloaded'), { timeout: T }).toBe(true);
    const dl = events.find((e) => e.name === 'downloaded');
    expect(dl?.dims.outFmt).toBe('webp');

    // The download wiring created + clicked a real <a download> (the mechanism the marker attends).
    expect(clickSpy).toHaveBeenCalledTimes(1);
  } finally {
    clickSpy.mockRestore();
    ui.dispose();
    document.head.querySelector('style')?.remove();
    document.body.innerHTML = '';
  }
}, T);

// CTA demand signal (spec §7, funnel B2B/self-host intent): the two "run at scale /
// self-host" CTAs emit `cta_clicked` with the CTA id. `emit` is ASYNC here (mirrors the
// real guest's `writer.write`), so the handlers must reliably deliver the marker even
// though the click callback cannot itself be awaited — a lost CTA marker would drop the
// exact inbound signal Phase 2 gates on. The result-scale CTA is only present after a run.
test('the app guest UI emits cta_clicked for both self-host CTAs (async-emit-safe)', async () => {
  const events: TelemetryEvent[] = [];
  const RIFF_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const ui = renderImageToolUI(document, {
    runWorkflow: async () => RIFF_WEBP,
    // Async emit: record only on a later microtask, so a fire-and-forget handler that
    // failed to schedule/handle the promise would never record the event.
    emit: (name, dims) => Promise.resolve().then(() => { events.push({ name, dims: dims ?? {} }); }),
  });

  try {
    // The always-present landing CTA fires immediately.
    (document.getElementById('cta-landing-link') as HTMLElement).click();
    await expect.poll(() => events.some((e) => e.name === 'cta_clicked' && e.dims.cta === 'landing'), { timeout: T }).toBe(true);

    // The result-scale CTA appears only after a successful run.
    await ui.loadFile(await fixturePng(40, 20), 'shot.png');
    ui.runBtn.click();
    await expect.poll(() => events.some((e) => e.name === 'previewed'), { timeout: T }).toBe(true);
    (document.getElementById('cta-scale') as HTMLElement).click();
    await expect.poll(() => events.some((e) => e.name === 'cta_clicked' && e.dims.cta === 'result-scale'), { timeout: T }).toBe(true);
  } finally {
    ui.dispose();
    document.head.querySelector('style')?.remove();
    document.body.innerHTML = '';
  }
}, T);
