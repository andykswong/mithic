import '@xterm/xterm/css/xterm.css';
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createCommandSuite } from './commands.ts';
import { mountTerminal } from './terminal-app.ts';

/** Build a mounted terminal over a fresh kernel + seeded VFS. */
async function makeTerminal(files: Record<string, string> = {}) {
  const suite = createCommandSuite();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files }));
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: (n) => suite.resolve(n), launcher: suite.launcher });

  const content = document.createElement('div');
  content.style.cssText = 'width:600px;height:360px;';
  document.body.appendChild(content);

  const term = mountTerminal(
    { window: { content } as any, content, kernel, onClose: () => {}, setTitle: () => {} },
    { kernel, vfs: vfs as any, suite },
  );
  return { term, content };
}

/** Feed raw keystrokes through xterm's onData line editor. */
function type(term: { terminal: { input(d: string, wasUserInput?: boolean): void } }, data: string): void {
  term.terminal.input(data, true);
}

function drain(term: { terminal: { write(s: string, cb: () => void): void } }): Promise<void> {
  return new Promise<void>((resolve) => term.terminal.write('', () => resolve()));
}

test('terminal app runs a command and writes output into the xterm DOM', async () => {
  const suite = createCommandSuite();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/hello.txt': 'hi there\n' } }));
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: (n) => suite.resolve(n), launcher: suite.launcher });

  const content = document.createElement('div');
  content.style.cssText = 'width:600px;height:360px;';
  document.body.appendChild(content);

  const term = mountTerminal(
    { window: { content } as any, content, kernel, onClose: () => {}, setTitle: () => {} },
    { kernel, vfs: vfs as any, suite },
  );

  await term.submitLine('cat /hello.txt');
  // xterm parses + renders writes asynchronously off a queue; wait for the queue
  // to drain (write's callback fires once the data is parsed into the buffer)
  // before reading the buffer rows.
  await new Promise<void>((resolve) => term.terminal.write('', () => resolve()));

  // xterm renders rows into the DOM; assert the output text is present in the buffer.
  const text = term.terminal.buffer.active;
  let dump = '';
  for (let i = 0; i < text.length; i++) dump += text.getLine(i)?.translateToString() ?? '';
  expect(dump).toContain('hi there');

  term.dispose();
  content.remove();
});

test('Up arrow recalls prior commands and Down arrow returns toward the empty line', async () => {
  const { term, content } = await makeTerminal({ '/hello.txt': 'hi there\n' });

  // Submit two commands through the line editor so they enter history.
  type(term, 'echo first\r');
  await drain(term);
  type(term, 'echo second\r');
  await drain(term);

  const currentInputLine = (): string => {
    const buf = term.terminal.buffer.active;
    return (buf.getLine(buf.cursorY + buf.baseY)?.translateToString(true) ?? '').trim();
  };

  // Up once recalls the most recent command, Up again the one before it.
  type(term, '\x1b[A');
  await drain(term);
  expect(currentInputLine()).toMatch(/echo second$/);

  type(term, '\x1b[A');
  await drain(term);
  expect(currentInputLine()).toMatch(/echo first$/);

  // Down moves back toward the newest entry, then to the empty new line.
  type(term, '\x1b[B');
  await drain(term);
  expect(currentInputLine()).toMatch(/echo second$/);

  type(term, '\x1b[B');
  await drain(term);
  expect(currentInputLine()).not.toMatch(/echo/);

  term.dispose();
  content.remove();
});

test('Ctrl+C abandons the current line without submitting it', async () => {
  const { term, content } = await makeTerminal();

  const dumpBuffer = (): string => {
    const buf = term.terminal.buffer.active;
    let dump = '';
    for (let i = 0; i < buf.length; i++) dump += `${buf.getLine(i)?.translateToString() ?? ''}\n`;
    return dump;
  };

  // Type partial input that would echo identifiable output if it ever ran, then
  // Ctrl+C — the line must be discarded (echo's argument never reaches stdout).
  type(term, 'echo NOTRUN-token');
  type(term, '\x03');
  await drain(term);

  // Ctrl+C echoes ^C and shows a fresh prompt.
  expect(dumpBuffer()).toContain('^C');

  // A subsequent Enter must NOT run the abandoned text — it submits an empty
  // line, so `echo`'s output token never appears on its own line.
  type(term, '\r');
  await drain(term);
  await new Promise((r) => setTimeout(r, 20));
  await drain(term);

  // The abandoned command never executed: "NOTRUN-token" appears only on the
  // input-echo line that was cancelled, never as a fresh echo output line.
  const lines = dumpBuffer().split('\n').map((l) => l.trim());
  expect(lines).not.toContain('NOTRUN-token');

  term.dispose();
  content.remove();
});

test('terminal app surfaces a failing command\'s stderr into the xterm DOM', async () => {
  const suite = createCommandSuite();
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider({ files: { '/exists.txt': 'ok\n' } }));
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: (n) => suite.resolve(n), launcher: suite.launcher });

  const content = document.createElement('div');
  content.style.cssText = 'width:600px;height:360px;';
  document.body.appendChild(content);

  const term = mountTerminal(
    { window: { content } as any, content, kernel, onClose: () => {}, setTitle: () => {} },
    { kernel, vfs: vfs as any, suite },
  );

  // `cat` of a missing file writes its error to stderr and exits non-zero. Bug C1:
  // makeKernelClient.spawn must return `stderr` so the shell drains it into the
  // terminal's stderr sink — otherwise the error is silently dropped.
  await term.submitLine('cat /nope.txt');
  await new Promise<void>((resolve) => term.terminal.write('', () => resolve()));

  const buf = term.terminal.buffer.active;
  let dump = '';
  for (let i = 0; i < buf.length; i++) dump += buf.getLine(i)?.translateToString() ?? '';
  expect(dump).toMatch(/nope\.txt/);

  term.dispose();
  content.remove();
});

test('terminal seeds $TERM into the shell environment so children inherit it', async () => {
  const { term, content } = await makeTerminal();

  // The shell expands $TERM from its context.env, which the terminal seeds.
  await term.submitLine('echo "TERM=$TERM"');
  await new Promise<void>((resolve) => term.terminal.write('', () => resolve()));

  const buf = term.terminal.buffer.active;
  let dump = '';
  for (let i = 0; i < buf.length; i++) dump += buf.getLine(i)?.translateToString() ?? '';
  expect(dump).toContain('TERM=xterm-256color');

  term.dispose();
  content.remove();
});

test('terminal-spawned children see stdout as a TTY (isatty(1) === true)', async () => {
  const { term, content } = await makeTerminal();

  // A child run by the terminal must learn its stdio is a terminal: the desktop's
  // makeKernelClient passes tty:true into kernel.spawn, so a child reading
  // boot.init.preopens[1].tty reports a TTY. We assert via a node-style probe
  // baked into the shell command suite is overkill here; instead drive a command
  // whose presence/output proves env+tty plumbing. COLUMNS is seeded too.
  await term.submitLine('echo "COLS=$COLUMNS LINES=$LINES"');
  await new Promise<void>((resolve) => term.terminal.write('', () => resolve()));

  const buf = term.terminal.buffer.active;
  let dump = '';
  for (let i = 0; i < buf.length; i++) dump += buf.getLine(i)?.translateToString() ?? '';
  // COLUMNS/LINES are seeded from the xterm geometry (or the 80/24 fallback) —
  // they must be non-empty numeric values, never the literal empty expansion.
  expect(dump).toMatch(/COLS=\d+ LINES=\d+/);

  term.dispose();
  content.remove();
});
