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

/** Read the first non-empty visible buffer line. */
function firstLine(a: ShellApp): string {
  const buf = a.terminal.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const s = buf.getLine(y)?.translateToString(true) ?? '';
    if (s.trim().length > 0) return s;
  }
  return '';
}

/** Read the last non-empty visible buffer line (e.g. the trailing prompt). */
function lastNonEmptyLine(a: ShellApp): string {
  const buf = a.terminal.buffer.active;
  for (let y = buf.length - 1; y >= 0; y--) {
    const s = buf.getLine(y)?.translateToString(true) ?? '';
    if (s.trim().length > 0) return s;
  }
  return '';
}

test('banner renders cleanly: ascii-art is the first line and xterm.css hides the helper textarea', async () => {
  const el = mount();
  app = await bootShell(el);
  await flush();

  // The banner is now a SOURCED .bashrc: its `echo -e` lines print the MITHIC
  // ascii-art block, so the first visible buffer line is the top of that art
  // (the `█`/`╗` box-drawing row) — not a plain heading and not garbage above it.
  const first = firstLine(app);
  expect(first).toMatch(/[█╗]/);

  // The npm-install call-to-action and the GitHub/API-Docs labels appear too,
  // proving `echo -e` rendered the ANSI/OSC-8 escapes from the bashrc.
  const buf = readBuffer(app);
  expect(buf).toContain('npm install mithic');
  expect(buf).toContain('GitHub');
  expect(buf).toContain('API Docs');

  // ROOT-CAUSE GUARD. The garbage "2…$" row that rendered ABOVE the heading was
  // the xterm helper textarea (composition mirror) painted at top:0 because
  // xterm.css — which sets `.xterm-helper-textarea { opacity: 0 }` — was never
  // bundled. main.ts now imports the CSS; assert the helper is hidden so a
  // dropped import (the regression) fails here. Without the CSS this opacity is "1".
  const helper = el.querySelector('.xterm-helper-textarea') as HTMLElement | null;
  expect(helper).not.toBeNull();
  expect(getComputedStyle(helper as HTMLElement).opacity).toBe('0');
}, T);

test('PS1 prompt: after boot the prompt is the bash-style cwd form (HOME=/ collapses to ~)', async () => {
  app = await bootShell(mount());
  await flush();
  // The bashrc's `export PS1="\e[1;32m\w\e[0m\$ "` makes the prompt `~$ ` (cwd
  // `/` collapsed against HOME=/). translateToString drops the ESC color codes,
  // so the visible prompt text is `~$`.
  const last = lastNonEmptyLine(app);
  expect(last).toMatch(/~\$\s*$/);
}, T);

test('PS1 prompt: cd /tmp updates the prompt to show /tmp (\\w tracks cwd)', async () => {
  app = await bootShell(mount());
  await flush();
  app.terminal.input('cd /tmp\r', true);
  await flush();
  // After cd, the live prompt reflects the new cwd via expandPrompt(\w).
  const last = lastNonEmptyLine(app);
  expect(last).toMatch(/\/tmp\$\s*$/);
}, T);

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

// Bug A coverage: `/dev` must be mounted AND reachable through the example's REAL
// wiring (the gap that let Bug A ship — the node repro proved /dev was missing).
// A BOUNDED read of /dev/zero piped through base64 must produce output. 8 zero
// bytes base64-encode to "AAAAAAAAAAA=". `head -c 8` keeps it deterministic and
// terminating (no truly-infinite producer in a browser test).
test('Bug A: head -c 8 /dev/zero | base64 produces output (/dev mounted + reachable)', async () => {
  app = await bootShell(mount());
  app.terminal.input('head -c 8 /dev/zero | base64\r', true);
  await flush();
  expect(readBuffer(app)).toContain('AAAAAAAAAAA=');
}, T);

// Bug B coverage: a FAILING external command must show its error in the terminal.
// Before the fix, `spawnExternal` discarded the child's stderr, so `cat` of a
// missing file produced NOTHING — not even the diagnostic. Assert the terminal
// buffer now contains the error text end-to-end through the example wiring.
test('Bug B: a failing command shows its stderr in the terminal', async () => {
  app = await bootShell(mount());
  app.terminal.input('cat /nonexistent\r', true);
  await flush();
  const buf = readBuffer(app);
  expect(buf).toMatch(/nonexistent/);
  expect(buf).toMatch(/not found|No such file/i);
}, T);
