/**
 * Browser test for the xterm.js shell notebook (Group P.2), in real Chromium.
 *
 * Verifies the two capstone outcomes:
 *   1. xterm <-> shell round-trip: typing `echo hi | cat\n` runs the real
 *      shell-js interpreter (in-process builtin pipeline) and `hi` appears in
 *      the terminal buffer.
 *   2. Inline GUI: typing `open-image\n` spawns the image-viewer GUI process via
 *      Kernel + IframeRuntime in `display:inline`, mounting an iframe into the
 *      results pane.
 *
 * The shell is driven via xterm's `input()` (fires `onData` exactly like a real
 * keystroke). Reading the terminal buffer back asserts the output.
 */
import { afterEach, expect, test } from 'vitest';
import { bootNotebook } from './main.ts';
import type { Notebook } from './main.ts';

let nb: Notebook | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  nb?.dispose();
  nb = undefined;
  host?.remove();
  host = undefined;
});

function mount(): { termEl: HTMLElement; resultsEl: HTMLElement } {
  host = document.createElement('div');
  const termEl = document.createElement('div');
  const resultsEl = document.createElement('div');
  host.appendChild(termEl);
  host.appendChild(resultsEl);
  document.body.appendChild(host);
  return { termEl, resultsEl };
}

/** Read the entire xterm scrollback+viewport as a single string. */
function readBuffer(nb: Notebook): string {
  const buf = nb.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

async function flush(): Promise<void> {
  // Let the async submitLine (executor.run) settle and xterm render.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 20));
}

test('notebook: echo hi | cat round-trips "hi" through the shell into the terminal', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);

  // Type the command exactly as a user would, then press Enter.
  nb.terminal.input('echo hi | cat\r', true);
  await flush();

  expect(readBuffer(nb)).toContain('hi');
}, 20000);

test('notebook: open-image spawns an inline image-viewer iframe in the results pane', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);

  expect(resultsEl.querySelectorAll('iframe').length).toBe(0);

  nb.terminal.input('open-image\r', true);
  await flush();

  // The GUI-capable IframeRuntime mounted the inline iframe into the results pane.
  const frames = resultsEl.querySelectorAll('iframe');
  expect(frames.length).toBeGreaterThan(0);
  // Inline display => not display:none (hidden mode would be off-screen on body).
  expect((frames[0] as HTMLIFrameElement).style.display).not.toBe('none');
  expect(readBuffer(nb)).toContain('spawned image-viewer');
}, 20000);
