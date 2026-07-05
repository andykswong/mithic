import { createGuest, readPath, writePath } from '@mithic/guest-runtime';
import { STYLES } from './styles.ts';

const FORMATS = ['webp', 'jpeg', 'png'] as const;
type Fmt = (typeof FORMATS)[number];
const EXT: Record<Fmt, string> = { webp: 'webp', jpeg: 'jpeg', png: 'png' };

// ---- content-free telemetry markers ----
// Inlined so the guest is a self-contained `?bundle` (importing the host `telemetry.ts`
// would drag its sinks/allowlist machinery into the guest). MUST stay in sync with
// `telemetry.ts` (`MARKER_PREFIX` + `esc` + `sizeBucket`/`widthBucket`); the host
// `parseMarker`/`sanitizeEvent` reverse this exactly. `telemetry.browser.test.ts` pins
// the escaping round-trip against the host parser.
const MARKER_PREFIX = 'mithic-ev';

/** Escape control chars structural in the tab/newline line protocol (byte-identical to `telemetry.ts` `esc`). */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Build a marker line: `mithic-ev\t<name>\t<k=v>...` with keys and values escaped. */
function marker(name: string, dims: Record<string, string> = {}): string {
  const kvs = Object.entries(dims).map(([k, v]) => `${esc(k)}=${esc(v)}`);
  return [MARKER_PREFIX, name, ...kvs].join('\t');
}

/** Coarse size bucket — NEVER the raw byte count. Mirrors `telemetry.ts` `sizeBucket`. */
function sizeBucket(b: number): string {
  if (b < 100 * 1024) return '<100KB';
  if (b < 1024 * 1024) return '100KB-1MB';
  if (b < 5 * 1024 * 1024) return '1-5MB';
  if (b < 20 * 1024 * 1024) return '5-20MB';
  return '>20MB';
}

/** Coarse source-width bucket. Mirrors `telemetry.ts` `widthBucket`. */
function widthBucket(px: number): string {
  if (px <= 512) return 'small';
  if (px <= 1536) return 'medium';
  if (px <= 4096) return 'large';
  return 'xlarge';
}

/**
 * Wrap raw bytes in a Blob. Copies into a fresh ArrayBuffer-backed view so the part
 * is statically a `BlobPart` — a `Uint8Array` off a syscall may be over a
 * `SharedArrayBuffer`, which `BlobPart` excludes (mirrors coreutils `bytesToBlob`).
 */
function toBlob(bytes: Uint8Array, type?: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return type === undefined ? new Blob([copy]) : new Blob([copy], { type });
}

/** The one privileged operation the UI needs delegated: run the resize-convert workflow. */
export interface WorkflowRequest {
  /** The source image bytes (already read from the chosen/dropped file). */
  bytes: Uint8Array;
  /** The source file name (drives the VFS in/out paths). */
  name: string;
  /** The chosen target width (px). */
  targetWidth: number;
  /** The chosen output format. */
  format: Fmt;
}

/**
 * Host/guest deps the pure-DOM UI needs. Injecting these keeps
 * {@link renderImageToolUI} a pure-DOM factory (no `createGuest`, no syscall,
 * no stdout), so it can be exercised against a test's own `document` — the
 * opaque-origin app iframe's `contentDocument` is cross-origin-blocked in the
 * browser test harness, so a genuine in-iframe drop cannot be dispatched from
 * the test realm. `main(boot)` wires the real guest-backed implementations.
 */
export interface ImageToolDeps {
  /** Write the source bytes, run the workflow, read the output back; returns the produced bytes. */
  runWorkflow(request: WorkflowRequest): Promise<Uint8Array>;
  /** Emit a content-free telemetry marker. Optional (defaults to a no-op). */
  emit?: (name: string, dims?: Record<string, string>) => void | Promise<void>;
}

/** Handle returned by {@link renderImageToolUI} so a caller/test can drive it programmatically. */
export interface ImageToolHandle {
  /** The rendered "Resize & convert" button. */
  readonly runBtn: HTMLButtonElement;
  /** Load a file's bytes as the source (the same path the drop handler takes). */
  loadFile(bytes: Uint8Array, name: string): Promise<void>;
  /** Set the target width programmatically (test hook / env hook). */
  setWidth(w: number): void;
  /** Set the output format programmatically (test hook / env hook). */
  setFormat(f: Fmt): void;
  /** Revoke any live object URLs this UI minted. */
  dispose(): void;
}

/**
 * Build the image-tool UI into `doc.body` (layout C, progressive-reveal, mobile-first)
 * and wire the drop / picker / controls / run / download flow. Pure DOM — the only
 * privileged operation (running the workflow) is delegated through {@link ImageToolDeps}.
 * Returns a handle so a caller (or an in-realm test) can drive a synthetic drop and
 * assert the reveal order without a cross-origin iframe reach-in.
 */
export function renderImageToolUI(doc: Document, deps: ImageToolDeps): ImageToolHandle {
  const emit = (name: string, dims?: Record<string, string>): void | Promise<void> =>
    deps.emit ? deps.emit(name, dims) : undefined;

  // ---- UI state ----
  let sourceBytes: Uint8Array | undefined;
  let sourceName = 'image';
  let sourceWidth = 0;
  let targetWidth = 1024;
  let format: Fmt = 'webp';
  let lastOutUrl: string | undefined;
  let origUrl: string | undefined;

  // ---- DOM (layout C) ----
  doc.head.appendChild(Object.assign(doc.createElement('style'), { textContent: STYLES }));
  doc.body.innerHTML = `
    <h1>Resize &amp; convert an image</h1>
    <div class="sub">privacy-first · no upload · runs on your machine</div>
    <div id="privacy" class="privacy">
      <span>🔒 Your images never leave your device. We count only anonymous, content-free usage events — never a filename or a byte of your image.</span>
      <button id="privacy-dismiss" aria-label="Dismiss">✕</button>
    </div>
    <div id="drop">⬇ Drop an image to start<br><small>or click to choose · nothing is uploaded</small>
      <input id="file" type="file" accept="image/*" class="hidden">
    </div>
    <div id="controls" class="controls hidden">
      <img id="orig" class="hidden" alt="original">
      <div class="label">Target width <span id="wnote"></span></div>
      <div class="row"><input id="slider" type="range" min="16" step="1"><input id="wnum" type="number" min="16"></div>
      <div class="row" id="chips"></div>
      <div class="label">Output format</div>
      <div class="row" id="fmts"></div>
      <button id="run">Resize &amp; convert →</button>
    </div>
    <div id="result" class="result hidden">
      <div style="text-align:center;color:#a6e3a1;font-size:12px" id="resultmsg"></div>
      <img id="preview" alt="result">
      <div class="stats"><div class="stat" id="statbefore"></div><div class="stat after" id="statafter"></div></div>
      <button id="download">⬇ Download</button>
      <div style="text-align:center;margin-top:6px"><a class="cta-link" id="again">↺ try another</a></div>
      <div class="cta"><b>Need to do this to 1,000 images?</b><button id="cta-scale">Run at scale / self-host →</button></div>
    </div>
    <div class="cta" id="cta-landing" style="margin-top:20px"><a class="cta-link" id="cta-landing-link">Doing this a lot? →</a></div>
  `;

  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const drop = $('drop'), fileInput = $<HTMLInputElement>('file');
  const controls = $('controls'), orig = $<HTMLImageElement>('orig');
  const slider = $<HTMLInputElement>('slider'), wnum = $<HTMLInputElement>('wnum'), wnote = $('wnote');
  const chips = $('chips'), fmts = $('fmts'), runBtn = $<HTMLButtonElement>('run');
  const result = $('result'), preview = $<HTMLImageElement>('preview');
  const statBefore = $('statbefore'), statAfter = $('statafter'), resultMsg = $('resultmsg');
  const downloadBtn = $<HTMLAnchorElement | HTMLButtonElement>('download') as HTMLButtonElement;

  // Width chips (presets + Max).
  const PRESETS = [512, 1024, 2048];
  const setWidth = (w: number) => {
    targetWidth = Math.max(16, Math.min(w, sourceWidth || w));
    slider.value = String(targetWidth); wnum.value = String(targetWidth);
    for (const el of chips.querySelectorAll('.chip')) el.classList.toggle('sel', Number((el as HTMLElement).dataset.w) === targetWidth);
  };
  for (const p of PRESETS) {
    const b = doc.createElement('button'); b.className = 'chip'; b.textContent = String(p); b.dataset.w = String(p);
    b.onclick = () => setWidth(p); chips.appendChild(b);
  }
  const maxChip = doc.createElement('button'); maxChip.className = 'chip'; maxChip.textContent = 'Max';
  maxChip.onclick = () => setWidth(sourceWidth || targetWidth); chips.appendChild(maxChip);
  slider.oninput = () => setWidth(Number(slider.value));
  wnum.oninput = () => setWidth(Number(wnum.value));

  // Format buttons.
  const setFormat = (f: Fmt) => {
    format = f;
    for (const el of fmts.querySelectorAll('.fmt')) el.classList.toggle('sel', (el as HTMLElement).dataset.f === f);
  };
  for (const f of FORMATS) {
    const b = doc.createElement('button'); b.className = 'fmt' + (f === format ? ' sel' : ''); b.textContent = f.toUpperCase(); b.dataset.f = f;
    b.onclick = () => setFormat(f);
    fmts.appendChild(b);
  }

  const baseName = () => sourceName.replace(/\.[^.]+$/, '');

  // ---- load a dropped/chosen file ----
  const loadFile = async (bytes: Uint8Array, name: string): Promise<void> => {
    sourceBytes = bytes; sourceName = name;
    const bmp = await createImageBitmap(toBlob(bytes));
    sourceWidth = bmp.width; bmp.close();
    slider.max = String(sourceWidth);
    wnote.textContent = `· source ${sourceWidth}px · won't upscale`;
    if (origUrl) URL.revokeObjectURL(origUrl);
    origUrl = URL.createObjectURL(toBlob(bytes));
    orig.src = origUrl;
    orig.classList.remove('hidden');
    controls.classList.remove('hidden');
    result.classList.add('hidden');
    setWidth(Math.min(1024, sourceWidth));
    await emit('file_dropped', { inFmt: name.split('.').pop() ?? 'unknown', srcWidthBucket: widthBucket(sourceWidth) });
  };

  drop.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (f) await loadFile(new Uint8Array(await f.arrayBuffer()), f.name);
  };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) await loadFile(new Uint8Array(await f.arrayBuffer()), f.name);
  });

  // ---- run the workflow ----
  runBtn.onclick = async () => {
    if (!sourceBytes) return;
    runBtn.disabled = true;
    const t0 = performance.now();
    try {
      await emit('processing_started', { outFmt: format, targetWidth: String(targetWidth) });
      const outBytes = await deps.runWorkflow({ bytes: sourceBytes, name: sourceName, targetWidth, format });
      const ms = Math.round(performance.now() - t0);
      // Preview: mint a blob INSIDE this iframe (G6 img-src blob:).
      if (lastOutUrl) URL.revokeObjectURL(lastOutUrl);
      lastOutUrl = URL.createObjectURL(toBlob(outBytes, `image/${format}`));
      preview.src = lastOutUrl;
      statBefore.textContent = `before · ${sizeBucket(sourceBytes.byteLength)} · ${sourceWidth}px`;
      statAfter.textContent = `after · ${sizeBucket(outBytes.byteLength)} · ${targetWidth}px ${format.toUpperCase()}`;
      resultMsg.textContent = `✓ processed in ${ms} ms · 0 bytes uploaded`;
      result.classList.remove('hidden');
      await emit('processed', {
        inFmt: sourceName.split('.').pop() ?? 'unknown', outFmt: format,
        srcWidthBucket: widthBucket(sourceWidth), targetWidth: String(targetWidth),
        bytesInBucket: sizeBucket(sourceBytes.byteLength), bytesOutBucket: sizeBucket(outBytes.byteLength),
        ms: String(ms),
      });
      // Download wiring (allow-downloads on the visible iframe makes this work).
      downloadBtn.onclick = () => {
        const a = doc.createElement('a');
        a.href = lastOutUrl!; a.download = `${baseName()}.${EXT[format]}`; a.click();
        void emit('downloaded', { outFmt: format });
      };
      await emit('previewed', { outFmt: format });
    } catch (err) {
      resultMsg.textContent = `error: ${(err as Error).message}`;
      result.classList.remove('hidden');
      await emit('process_error', { errorClass: (err as Error).name || 'Error' });
    } finally {
      runBtn.disabled = false;
    }
  };

  $('again').onclick = () => { result.classList.add('hidden'); drop.scrollIntoView(); };
  $('cta-scale').onclick = () => void emit('cta_clicked', { cta: 'result-scale' });
  $('cta-landing-link').onclick = () => void emit('cta_clicked', { cta: 'landing' });

  // Dismissible privacy notice (spec §7). The guest can't reach host storage, so
  // "dismiss" is in-session (hides the banner); a real deployment can persist a flag
  // host-side later. The notice states the content-free posture verbatim.
  $('privacy-dismiss').onclick = () => $('privacy').classList.add('hidden');

  const dispose = () => {
    if (lastOutUrl) URL.revokeObjectURL(lastOutUrl);
    if (origUrl) URL.revokeObjectURL(origUrl);
  };

  return { runBtn, loadFile, setWidth, setFormat, dispose };
}

export default async function main(boot: unknown): Promise<void> {
  const guest = createGuest(boot as Parameters<typeof createGuest>[0]);
  const ctx = { cwd: guest.cwd, fs: guest.fs };
  const writer = guest.stdout.getWriter();
  const enc = new TextEncoder();
  const emit = (name: string, dims?: Record<string, string>): Promise<void> =>
    writer.write(enc.encode(marker(name, dims) + '\n'));

  // The privileged workflow step: write the source into /in, run the resize-convert
  // pipeline (imgresize -> imgconvert via exec-from-VFS), read the produced bytes back.
  const runWorkflow = async ({ bytes, name, targetWidth, format }: WorkflowRequest): Promise<Uint8Array> => {
    const baseName = name.replace(/\.[^.]+$/, '');
    const inPath = `/in/${name}`;
    const outPath = `/out/${baseName}.${EXT[format]}`;
    await writePath(ctx, inPath, bytes);
    const r = (await guest.syscall('process/pipeline', {
      stages: [{ path: 'resize-convert', argv: ['resize-convert', String(targetWidth), format, inPath, outPath], env: guest.env, cwd: guest.cwd }],
    })) as { exitCodes: number[]; stdout: Uint8Array };
    const code = r.exitCodes[r.exitCodes.length - 1] ?? 1;
    if (code !== 0) throw new Error(`workflow exited ${code}`);
    return readPath(ctx, outPath);
  };

  const ui = renderImageToolUI(document, { runWorkflow, emit });

  await emit('page_view');

  // TEST HOOK (browser test only): if MITHIC_TEST_DROP is set, simulate a drop +
  // run so the funnel can be asserted without a synthetic DragEvent. Guarded by an
  // env var the PRODUCT PAGE NEVER SETS (boot.ts sets no MITHIC_TEST_* vars), so the
  // real path (drag-drop / picker → user clicks Run) is the only path in production.
  // Task 7 exercises THIS hook (deterministic funnel assertion); Task 8 exercises the
  // genuine drop path via the pure-DOM `renderImageToolUI` factory. The two are
  // mutually exclusive by the env guard — a real drop never runs this branch.
  if (guest.env.MITHIC_TEST_DROP) {
    const bytes = Uint8Array.from(atob(guest.env.MITHIC_TEST_DROP), (c) => c.charCodeAt(0));
    await ui.loadFile(bytes, guest.env.MITHIC_TEST_NAME ?? 'test.png');
    if (guest.env.MITHIC_TEST_WIDTH) ui.setWidth(Number(guest.env.MITHIC_TEST_WIDTH));
    if (guest.env.MITHIC_TEST_FORMAT) ui.setFormat(guest.env.MITHIC_TEST_FORMAT as Fmt);
    ui.runBtn.click();
  }

  // GUI process: stay alive until signalled.
  await new Promise<void>((resolve) => { guest.onSignal(() => resolve()); });
  ui.dispose();
  await writer.close().catch(() => {});
  guest.exit(0);
}
