import { expect, test } from 'vitest';
import { renderTextEditor, type EditorFs } from './text-editor.ts';

function memFs(initial: Record<string, string> = {}): EditorFs & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    async readFile(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    async writeFile(p, t) { files[p] = t; },
  };
}

test('editor renders a textarea into real DOM and round-trips save', async () => {
  const fs = memFs({ '/n.txt': 'abc' });
  const h = renderTextEditor(document, { fs, path: '/n.txt' });
  document.body.appendChild(h.root);
  await h.ready;
  const ta = h.root.querySelector('textarea')!;
  expect(ta).not.toBeNull();
  expect(ta.value).toBe('abc');

  ta.value = 'abcd';
  ta.dispatchEvent(new Event('input'));
  expect(h.dirty).toBe(true);
  await h.save();
  expect(fs.files['/n.txt']).toBe('abcd');
  expect(h.dirty).toBe(false);

  h.root.remove();
});

test('Tab keydown inserts a tab at the real selection offset (mid-text) and advances the caret', async () => {
  // Real-DOM coverage of the selectionStart/selectionEnd path the node fake cannot model.
  const fs = memFs({ '/n.txt': 'abcd' });
  const h = renderTextEditor(document, { fs, path: '/n.txt' });
  document.body.appendChild(h.root);
  await h.ready;
  const ta = h.root.querySelector('textarea')!;
  ta.focus();
  // Caret between 'ab' and 'cd'.
  ta.setSelectionRange(2, 2);

  const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
  ta.dispatchEvent(ev);

  expect(ev.defaultPrevented).toBe(true); // Tab did not move focus
  expect(ta.value).toBe('ab\tcd');
  expect(ta.selectionStart).toBe(3); // caret advanced past the inserted tab
  expect(ta.selectionEnd).toBe(3);
  expect(h.dirty).toBe(true);

  h.root.remove();
});

test('Tab over a non-empty selection replaces the selected range with a tab', async () => {
  const fs = memFs({ '/n.txt': 'abcd' });
  const h = renderTextEditor(document, { fs, path: '/n.txt' });
  document.body.appendChild(h.root);
  await h.ready;
  const ta = h.root.querySelector('textarea')!;
  ta.focus();
  ta.setSelectionRange(1, 3); // select 'bc'

  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true }));

  expect(ta.value).toBe('a\td');
  expect(h.dirty).toBe(true);

  h.root.remove();
});

test('Ctrl+S keydown saves via fs.writeFile (real DOM)', async () => {
  const fs = memFs({ '/n.txt': 'x' });
  const h = renderTextEditor(document, { fs, path: '/n.txt' });
  document.body.appendChild(h.root);
  await h.ready;
  const ta = h.root.querySelector('textarea')!;
  ta.value = 'saved-via-ctrl-s';
  ta.dispatchEvent(new Event('input'));
  expect(h.dirty).toBe(true);

  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, bubbles: true }));
  // The handler calls save() fire-and-forget; poll until the dirty flag clears.
  for (let i = 0; i < 50 && h.dirty; i++) await new Promise((r) => setTimeout(r, 5));

  expect(fs.files['/n.txt']).toBe('saved-via-ctrl-s');
  expect(h.dirty).toBe(false);

  h.root.remove();
});
