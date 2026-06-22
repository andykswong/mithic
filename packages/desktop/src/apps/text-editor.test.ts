import { describe, expect, test, vi, afterEach } from 'vitest';
import { renderTextEditor, mountTextEditor, type EditorFs } from './text-editor.ts';
import type { WindowContext } from '../types.ts';

// Minimal fake document so the pure render fn is node-testable without jsdom.
function fakeDoc() {
  const make = () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const el: any = {
      tagName: '', style: {}, children: [] as any[], value: '', textContent: '', readOnly: false,
      dataset: {}, className: '',
      appendChild(c: any) { this.children.push(c); return c; },
      addEventListener(t: string, cb: (e: unknown) => void) { (listeners[t] ??= []).push(cb); },
      dispatch(t: string, e: unknown = {}) { (listeners[t] ?? []).forEach((cb) => cb(e)); },
      querySelector() { return null; },
      remove() {},
      focus() {},
    };
    return el;
  };
  return { createElement: (tag: string) => { const el = make(); el.tagName = tag.toUpperCase(); return el; } } as unknown as Document;
}

function memFs(initial: Record<string, string> = {}): EditorFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async readFile(path) { if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[path]; },
    async writeFile(path, text) { files[path] = text; },
  };
}

describe('renderTextEditor', () => {
  test('loads file content into the textarea', async () => {
    const fs = memFs({ '/a.txt': 'hello' });
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt' });
    await h.ready;
    expect(h.textarea.value).toBe('hello');
    expect(h.dirty).toBe(false);
  });
  test('starts empty (no dirty) for a nonexistent path', async () => {
    const fs = memFs();
    const h = renderTextEditor(fakeDoc(), { fs, path: '/new.txt' });
    await h.ready;
    expect(h.textarea.value).toBe('');
    expect(h.dirty).toBe(false);
  });
  test('edits set dirty; save writes to fs and clears dirty', async () => {
    const fs = memFs({ '/a.txt': 'x' });
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt' });
    await h.ready;
    h.textarea.value = 'changed';
    (h.textarea as any).dispatch('input');
    expect(h.dirty).toBe(true);
    await h.save();
    expect(fs.files['/a.txt']).toBe('changed');
    expect(h.dirty).toBe(false);
  });
  test('readOnly disables editing and the save path', async () => {
    const fs = memFs({ '/a.txt': 'x' });
    const save = vi.spyOn(fs, 'writeFile');
    const h = renderTextEditor(fakeDoc(), { fs, path: '/a.txt', readOnly: true });
    await h.ready;
    expect(h.textarea.readOnly).toBe(true);
    await h.save();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('mountTextEditor onClose (H4)', () => {
  const realConfirm = (globalThis as { confirm?: unknown }).confirm;
  afterEach(() => {
    if (realConfirm === undefined) delete (globalThis as { confirm?: unknown }).confirm;
    else (globalThis as { confirm?: unknown }).confirm = realConfirm;
  });

  function fakeCtx(doc: Document): { ctx: WindowContext; fireClose(): void } {
    const content = doc.createElement('div');
    (content as { ownerDocument: Document }).ownerDocument = doc;
    let cb: (() => void | Promise<void>) | undefined;
    const ctx = {
      content,
      onClose: (fn: () => void | Promise<void>) => { cb = fn; },
      setTitle: () => {},
    } as unknown as WindowContext;
    return { ctx, fireClose: () => cb?.() };
  }

  test('closing a dirty editor does not throw and never prompts (v1 has no unsaved guard)', async () => {
    // H4: the previous code called confirm() but ignored the result, so the prompt
    // was dead. The honest v1 behavior is no prompt at all — onClose must be a no-op
    // for the unsaved case and must NOT invoke confirm.
    const confirmSpy = vi.fn(() => false);
    (globalThis as { confirm?: unknown }).confirm = confirmSpy;

    const fs = memFs({ '/a.txt': 'x' });
    const doc = fakeDoc();
    const { ctx, fireClose } = fakeCtx(doc);
    const h = mountTextEditor(ctx, ['/a.txt'], fs);
    await h.ready;
    h.textarea.value = 'changed';
    (h.textarea as unknown as { dispatch(t: string): void }).dispatch('input');
    expect(h.dirty).toBe(true);

    expect(() => fireClose()).not.toThrow();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
