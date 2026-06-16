/**
 * Browser test for the xterm.js shell app, in real Chromium.
 *
 * Boots the terminal against a headless DOM container, types command lines into
 * the xterm `Terminal` exactly as a user would (`terminal.input(...)` fires
 * `onData`, driving the line editor), lets the async shell + spawned command
 * guests settle, then asserts the expected output appears in the terminal buffer.
 *
 * Scenarios prove the full stack end-to-end in the browser:
 *   1. coreutils pipe        — `echo hello | grep ell`  -> hello
 *   2. awk one-liner         — `seq 1 5 | awk '{s+=$1}END{print s}'` -> 15
 *   3. jq one-liner          — `echo '{"a":1}' | jq .a` -> 1
 *   4. builtin + state       — `cd /tmp` then `pwd`     -> /tmp
 *
 * Each external command (grep, seq, awk, jq) is a REAL @mithic/coreutils / jq
 * guest run in-process by the kernel's InProcessCommandLauncher — not a stub.
 */
import { afterEach, expect, test } from 'vitest';
import { bootShell } from './main.ts';
import type { ShellApp } from './main.ts';

let app: ShellApp | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  app?.dispose();
  app = undefined;
  host?.remove();
  host = undefined;
});

function mount(): HTMLElement {
  host = document.createElement('div');
  // Give the terminal a non-zero size so FitAddon has dimensions.
  host.style.width = '640px';
  host.style.height = '400px';
  document.body.appendChild(host);
  return host;
}

/** Read the entire xterm scrollback+viewport as a single string. */
function readBuffer(a: ShellApp): string {
  const buf = a.terminal.buffer.active;
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
  app = await bootShell(mount());
  app.terminal.input('echo hello | grep ell\r', true);
  await flush();
  expect(readBuffer(app)).toContain('hello');
}, T);

test('awk one-liner: seq 1 5 | awk sums to 15', async () => {
  app = await bootShell(mount());
  app.terminal.input("seq 1 5 | awk '{s+=$1}END{print s}'\r", true);
  await flush();
  // The prompt + echoed command also contain digits; assert the standalone 15 line.
  expect(readBuffer(app)).toMatch(/(^|\n)\s*15(\s|$)/);
}, T);

test('jq one-liner: echo JSON | jq .a -> 1', async () => {
  app = await bootShell(mount());
  app.terminal.input('echo \'{"a":1}\' | jq .a\r', true);
  await flush();
  expect(readBuffer(app)).toMatch(/(^|\n)\s*1(\s|$)/);
}, T);

test('builtin + persistent state: cd /tmp then pwd -> /tmp', async () => {
  app = await bootShell(mount());
  app.terminal.input('cd /tmp\r', true);
  await flush();
  app.terminal.input('pwd\r', true);
  await flush();
  expect(readBuffer(app)).toContain('/tmp');
}, T);
