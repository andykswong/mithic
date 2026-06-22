import type { WindowContext } from '../types.ts';

/** The narrow file-I/O surface the editor needs (subset of FileSystemProvider semantics). */
export interface EditorFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface EditorDeps {
  fs: EditorFs;
  path: string;
  readOnly?: boolean;
}

export interface EditorHandle {
  readonly textarea: HTMLTextAreaElement;
  readonly root: HTMLElement;
  /** Resolves once the initial file load has completed. */
  readonly ready: Promise<void>;
  dirty: boolean;
  save(): Promise<void>;
}

/**
 * Build the editor DOM (toolbar + <textarea>) into a fresh root element and wire
 * load/save/dirty. Pure DOM — no window/kernel coupling, so it is node-testable
 * with a fake document. `mountTextEditor` adapts it to a real window.
 */
export function renderTextEditor(doc: Document, deps: EditorDeps): EditorHandle {
  const root = doc.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;background:#1e1e2e;color:#cdd6f4;';

  const bar = doc.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:4px 8px;font:12px sans-serif;background:#181825;';
  const label = doc.createElement('span');
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = 'Save';
  bar.appendChild(label);
  bar.appendChild(saveBtn);

  const textarea = doc.createElement('textarea') as HTMLTextAreaElement;
  textarea.style.cssText = 'flex:1 1 auto;width:100%;height:100%;resize:none;border:none;outline:none;'
    + 'font:13px ui-monospace,Menlo,monospace;background:#1e1e2e;color:#cdd6f4;padding:8px;';
  textarea.readOnly = !!deps.readOnly;

  root.appendChild(bar);
  root.appendChild(textarea);

  const handle: EditorHandle = {
    textarea, root, dirty: false, ready: Promise.resolve(),
    async save() {
      if (deps.readOnly) return;
      await deps.fs.writeFile(deps.path, textarea.value);
      handle.dirty = false;
      updateLabel();
    },
  };

  const updateLabel = (): void => {
    label.textContent = `${deps.path}${handle.dirty ? ' *' : ''}${deps.readOnly ? ' (read-only)' : ''}`;
  };

  // Tab inserts a tab char rather than moving focus.
  textarea.addEventListener('keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      markDirty();
    }
    // Ctrl/Cmd+S saves.
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      void handle.save();
    }
  });

  const markDirty = (): void => {
    if (deps.readOnly || handle.dirty) return;
    handle.dirty = true;
    updateLabel();
  };
  textarea.addEventListener('input', markDirty);
  saveBtn.addEventListener('click', () => { void handle.save(); });

  // Initial load.
  (handle as { ready: Promise<void> }).ready = (async () => {
    let text = '';
    try { text = await deps.fs.readFile(deps.path); } catch { text = ''; }
    textarea.value = text;
    handle.dirty = false;
    updateLabel();
  })();

  updateLabel();
  return handle;
}

/** Adapt a WindowContext into a mounted editor. `argv[0]` is the file path. */
export function mountTextEditor(ctx: WindowContext, argv: string[], fs: EditorFs): EditorHandle {
  const path = argv[0] ?? '/untitled.txt';
  const h = renderTextEditor(ctx.content.ownerDocument, { fs, path });
  ctx.content.appendChild(h.root);
  ctx.setTitle(`Editor — ${path}`);
  ctx.onClose(() => {
    // v1 has no unsaved-changes guard: the WM exposes no veto channel for onClose,
    // so a confirm()-based prompt could never actually cancel the close. We just
    // warn when dirty and let the close proceed.
    if (h.dirty) console.warn(`mithic-wm: closing ${path} with unsaved changes`);
  });
  return h;
}
