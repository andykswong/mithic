import { createGuest, readPath, writePath } from '@mithic/guest-runtime';
import { STYLES } from './styles.ts';
import { guestMarker as marker, sizeBucket, widthBucket } from './guest-marker.ts';

const FORMATS = ['webp', 'jpeg', 'png'] as const;
type Fmt = (typeof FORMATS)[number];
const EXT: Record<Fmt, string> = { webp: 'webp', jpeg: 'jpeg', png: 'png' };

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

export default async function main(boot: unknown): Promise<void> {
  const guest = createGuest(boot as Parameters<typeof createGuest>[0]);
  const ctx = { cwd: guest.cwd, fs: guest.fs };
  const writer = guest.stdout.getWriter();
  const enc = new TextEncoder();
  const emit = (name: string, dims?: Record<string, string>): Promise<void> =>
    writer.write(enc.encode(marker(name, dims) + '\n'));

  // ---- UI state ----
  let sourceBytes: Uint8Array | undefined;
  let sourceName = 'image';
  let sourceWidth = 0;
  let targetWidth = 1024;
  let format: Fmt = 'webp';
  let lastOutUrl: string | undefined;

  // ---- DOM (layout C) ----
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLES }));
  document.body.innerHTML = `
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

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = String(p); b.dataset.w = String(p);
    b.onclick = () => setWidth(p); chips.appendChild(b);
  }
  const maxChip = document.createElement('button'); maxChip.className = 'chip'; maxChip.textContent = 'Max';
  maxChip.onclick = () => setWidth(sourceWidth || targetWidth); chips.appendChild(maxChip);
  slider.oninput = () => setWidth(Number(slider.value));
  wnum.oninput = () => setWidth(Number(wnum.value));

  // Format buttons.
  for (const f of FORMATS) {
    const b = document.createElement('button'); b.className = 'fmt' + (f === format ? ' sel' : ''); b.textContent = f.toUpperCase(); b.dataset.f = f;
    b.onclick = () => { format = f; for (const el of fmts.querySelectorAll('.fmt')) el.classList.toggle('sel', (el as HTMLElement).dataset.f === f); };
    fmts.appendChild(b);
  }

  // ---- load a dropped/chosen file ----
  const loadFile = async (bytes: Uint8Array, name: string): Promise<void> => {
    sourceBytes = bytes; sourceName = name;
    const bmp = await createImageBitmap(toBlob(bytes));
    sourceWidth = bmp.width; bmp.close();
    slider.max = String(sourceWidth);
    wnote.textContent = `· source ${sourceWidth}px · won't upscale`;
    orig.src = URL.createObjectURL(toBlob(bytes));
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
  const baseName = () => sourceName.replace(/\.[^.]+$/, '');
  runBtn.onclick = async () => {
    if (!sourceBytes) return;
    runBtn.disabled = true;
    const inPath = `/in/${sourceName}`;
    const outPath = `/out/${baseName()}.${EXT[format]}`;
    const t0 = performance.now();
    try {
      await writePath(ctx, inPath, sourceBytes);
      await emit('processing_started', { outFmt: format, targetWidth: String(targetWidth) });
      const r = (await guest.syscall('process/pipeline', {
        stages: [{ path: 'resize-convert', argv: ['resize-convert', String(targetWidth), format, inPath, outPath], env: guest.env, cwd: guest.cwd }],
      })) as { exitCodes: number[]; stdout: Uint8Array };
      const code = r.exitCodes[r.exitCodes.length - 1] ?? 1;
      if (code !== 0) throw new Error(`workflow exited ${code}`);
      const outBytes = await readPath(ctx, outPath);
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
        const a = document.createElement('a');
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
  $('cta-scale').onclick = () => emit('cta_clicked', { cta: 'result-scale' });
  $('cta-landing-link').onclick = () => emit('cta_clicked', { cta: 'landing' });

  // Dismissible privacy notice (spec §7). The guest can't reach host storage, so
  // "dismiss" is in-session (hides the banner); a real deployment can persist a flag
  // host-side later. The notice states the content-free posture verbatim.
  $('privacy-dismiss').onclick = () => $('privacy').classList.add('hidden');

  await emit('page_view');

  // TEST HOOK (browser test only): if MITHIC_TEST_DROP is set, simulate a drop +
  // run so the funnel can be asserted without a synthetic DragEvent. Guarded by an
  // env var the PRODUCT PAGE NEVER SETS (boot.ts sets no MITHIC_TEST_* vars), so the
  // real path (drag-drop / picker → user clicks Run) is the only path in production.
  // Task 7 exercises THIS hook (deterministic funnel assertion); Task 8 exercises the
  // genuine DragEvent path. The two are mutually exclusive by the env guard — a real
  // drop never runs this branch.
  if (guest.env.MITHIC_TEST_DROP) {
    const bytes = Uint8Array.from(atob(guest.env.MITHIC_TEST_DROP), (c) => c.charCodeAt(0));
    await loadFile(bytes, guest.env.MITHIC_TEST_NAME ?? 'test.png');
    if (guest.env.MITHIC_TEST_WIDTH) setWidth(Number(guest.env.MITHIC_TEST_WIDTH));
    if (guest.env.MITHIC_TEST_FORMAT) { format = guest.env.MITHIC_TEST_FORMAT as Fmt; }
    runBtn.click();
  }

  // GUI process: stay alive until signalled.
  await new Promise<void>((resolve) => { guest.onSignal(() => resolve()); });
  if (lastOutUrl) URL.revokeObjectURL(lastOutUrl);
  await writer.close().catch(() => {});
  guest.exit(0);
}
