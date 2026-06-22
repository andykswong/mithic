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
