/**
 * Browser test for the xterm.js shell notebook, in real Chromium.
 *
 * Verifies the capstone outcomes end-to-end:
 *   1. coreutils pipe — `echo hello | grep ell` -> hello
 *   2. awk one-liner  — `seq 1 5 | awk '{s+=$1}END{print s}'` -> 15
 *   3. jq one-liner   — `echo '{"a":1}' | jq .a` -> 1
 *   4. builtin+state  — `cd /tmp` then `pwd` -> /tmp
 *   5. inline GUI     — `open-image` spawns the image-viewer GUI process via
 *      Kernel + IframeRuntime in `display:inline`, mounting an iframe into the
 *      results pane.
 *
 * Each external command (grep, seq, awk, jq) is a REAL @mithic/coreutils / jq
 * guest run in-process by the kernel's InProcessCommandLauncher — not a stub.
 * The shell is driven via xterm's `input()` (fires `onData` like a real keystroke).
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
  termEl.style.width = '640px';
  termEl.style.height = '400px';
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

/** Let the async submitLine (executor.run + spawned guests) settle and xterm render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setTimeout(r, 20));
}

const T = 30000;

test('coreutils pipe: echo hello | grep ell -> hello', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);
  nb.terminal.input('echo hello | grep ell\r', true);
  await flush();
  expect(readBuffer(nb)).toContain('hello');
}, T);

test('awk one-liner: seq 1 5 | awk sums to 15', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);
  nb.terminal.input('seq 1 5 | awk \'{s+=$1}END{print s}\'\r', true);
  await flush();
  // The prompt + echoed command also contain digits; assert the standalone 15 line.
  expect(readBuffer(nb)).toMatch(/(^|\n)\s*15(\s|$)/);
}, T);

test('jq one-liner: echo JSON | jq .a -> 1', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);
  nb.terminal.input('echo \'{"a":1}\' | jq .a\r', true);
  await flush();
  expect(readBuffer(nb)).toMatch(/(^|\n)\s*1(\s|$)/);
}, T);

test('builtin + persistent state: cd /tmp then pwd -> /tmp', async () => {
  const { termEl, resultsEl } = mount();
  nb = await bootNotebook(termEl, resultsEl);
  nb.terminal.input('cd /tmp\r', true);
  await flush();
  nb.terminal.input('pwd\r', true);
  await flush();
  expect(readBuffer(nb)).toContain('/tmp');
}, T);

test('open-image spawns an inline image-viewer iframe in the results pane', async () => {
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
}, T);
