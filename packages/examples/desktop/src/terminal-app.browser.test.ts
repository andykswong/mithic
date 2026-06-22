import '@xterm/xterm/css/xterm.css';
import { expect, test } from 'vitest';
import { Kernel } from '@mithic/kernel';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { createCommandSuite } from './commands.ts';
import { mountTerminal } from './terminal-app.ts';

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
