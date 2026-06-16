/**
 * `@mithic/example-image-viewer` — a GUI image-viewer Isola process.
 *
 * This is an **iframe process**: the kernel launches it via the GUI-capable
 * `IframeRuntime`, so the guest runs inside a real (sandboxed, opaque-origin)
 * browser document and renders DIRECTLY into its own DOM — no Remote DOM
 * mirroring. It draws a drag-and-drop zone plus a preview `<img>`, and when a
 * file is dropped it creates an object URL and points the `<img>` at it.
 *
 * Self-reporting protocol (opaque-origin constraint):
 *   The host page cannot reach into the iframe's DOM cross-origin, so the guest
 *   reports its lifecycle on stdout as newline-delimited markers the host/test
 *   can assert on:
 *     - `ready`                 — the drop zone + <img> are mounted.
 *     - `img-rendered:<url>`    — a file was dropped; <img>.src is now <url>
 *                                 (an object: URL) and dimensions were captured.
 *
 * Note on the sandbox CSP: the iframe srcdoc ships `default-src 'none'`, which
 * blocks `blob:`/`object:` image fetches, so the dropped image does not visually
 * decode inside the sandbox. The DOM work — creating the `<img>`, wiring the
 * drop handler, and setting `.src` to the object URL — is nonetheless real and
 * is what this example demonstrates; the guest self-reports it on stdout.
 */
import { createGuest } from '@mithic/guest-runtime';

interface ImageViewerHandle {
  /** The rendered preview <img>. */
  readonly img: HTMLImageElement;
  /** Programmatically load a file (same path the drop handler takes). */
  loadFile(file: File): void;
}

/**
 * Render the drop-zone + preview <img> into `doc.body` and wire the file-drop
 * flow. Returns a handle so the caller (or an in-iframe test harness) can drive
 * a synthetic drop without a real pointer interaction. Pure DOM, no I/O.
 * Exported for reuse by callers that need programmatic access to the viewer.
 */
export function renderImageViewer(
  doc: Document,
  onRendered: (url: string) => void,
): ImageViewerHandle {
  const dropZone = doc.createElement('div');
  dropZone.id = 'drop-zone';
  dropZone.textContent = 'Drop an image here';
  Object.assign(dropZone.style, {
    border: '2px dashed #888',
    borderRadius: '8px',
    padding: '24px',
    textAlign: 'center',
    font: '14px sans-serif',
    color: '#444',
  });

  const img = doc.createElement('img');
  img.id = 'preview';
  img.alt = 'preview';
  img.style.maxWidth = '100%';
  img.style.display = 'none';

  const loadFile = (file: File): void => {
    const url = URL.createObjectURL(file);
    img.src = url;
    img.style.display = 'block';
    dropZone.textContent = file.name;
    onRendered(url);
  };

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  doc.body.appendChild(dropZone);
  doc.body.appendChild(img);

  return { img, loadFile };
}

export default async function main(boot: unknown): Promise<void> {
  const guest = createGuest(boot as Parameters<typeof createGuest>[0]);
  const writer = guest.stdout.getWriter();
  const encoder = new TextEncoder();
  const emit = (line: string): Promise<void> => writer.write(encoder.encode(`${line}\n`));

  renderImageViewer(document, (url) => {
    void emit(`img-rendered:${url}`);
  });

  await emit('ready');

  // GUI process: stay alive for interaction until signalled. Resolve on SIGTERM/
  // SIGKILL so the kernel can reap us cleanly.
  await new Promise<void>((resolve) => {
    guest.onSignal(() => resolve());
  });

  await writer.close().catch(() => { /* already closed */ });
  guest.exit(0);
}
