import { expect, test } from 'vitest';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import { createGuest } from './guest.ts';
import { MutationSerializer } from './remote-dom.ts';

function makeGuest(preopenPorts?: Record<number, MessagePort>) {
  const ctrl = new MessageChannel();
  const guest = createGuest({
    control: ctrl.port2,
    init: {
      type: 'init', entry: 'inline', args: ['prog', 'a'], env: { FOO: 'bar' },
      cwd: '/', pid: 9, ppid: 0, capabilities: [],
    },
    preopenPorts,
  });
  return { guest, kernelPort: ctrl.port1 };
}

test('createGuest exposes env/args/pid and stdio from init', async () => {
  const stdoutCh = new MessageChannel();
  const { guest } = makeGuest({ 1: stdoutCh.port1 });

  expect(guest.pid).toBe(9);
  expect(guest.args).toEqual(['prog', 'a']);
  expect(guest.env.FOO).toBe('bar');

  // Grant credit to the writable (port1) from the peer (port2) so write unblocks.
  stdoutCh.port2.start?.();
  stdoutCh.port2.postMessage({ type: 'credit', bytes: INITIAL_CREDIT_BYTES });

  const got: unknown[] = [];
  stdoutCh.port2.onmessage = (e) => got.push(e.data);

  const w = guest.stdout.getWriter();
  await w.write(new TextEncoder().encode('hi'));

  await new Promise(r => setTimeout(r, 20));
  expect(got.some(m => (m as { type?: string }).type === 'data')).toBe(true);

  stdoutCh.port1.close();
  stdoutCh.port2.close();
});

test('onSignal fires for kernel signal event and is not mis-delivered to syscall', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // Register the signal listener.
  const signals: string[] = [];
  guest.onSignal((sig) => signals.push(sig));

  // Kernel posts a signal event.
  kernelPort.postMessage({ event: 'signal', payload: { signal: 'SIGTERM' } });

  await new Promise(r => setTimeout(r, 20));
  expect(signals).toEqual(['SIGTERM']);

  // Also verify a pending syscall is NOT mis-delivered as a signal.
  // Start a syscall, reply with a valid syscall response — the signal listener must not fire.
  const syscallPromise = guest.syscall('process/getpid', {});
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number };
    if (req.id != null) {
      kernelPort.postMessage({ id: req.id, ok: true, result: { pid: 9 } });
    }
  };
  await syscallPromise;
  // Signal listeners should still only contain the original SIGTERM.
  expect(signals).toEqual(['SIGTERM']);

  kernelPort.close();
});

test('exit posts {type:"exit",code} and rejects in-flight syscalls', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // Collect messages sent to the kernel port.
  const kernelMessages: unknown[] = [];
  kernelPort.onmessage = (e) => kernelMessages.push(e.data);

  // Start a syscall that will never get a response.
  const hangingCall = guest.syscall('op/hang', {});

  // Call exit — should post {type:'exit',code} and close the transport.
  guest.exit(42);

  // Hanging syscall must reject with EPIPE.
  await expect(hangingCall).rejects.toMatchObject({ code: 'EPIPE' });

  await new Promise(r => setTimeout(r, 10));
  const exitMsg = kernelMessages.find(m => (m as { type?: string }).type === 'exit');
  expect(exitMsg).toMatchObject({ type: 'exit', code: 42 });

  kernelPort.close();
});

test('Seam 2: exit() tears down stdin, posting EPIPE to the upstream producer peer', async () => {
  // stdin is preopen fd 0: the guest holds the READ end (port-as-stdin); the peer
  // (port2) is the upstream producer's WRITE end. On exit the guest must post
  // {type:'error', code:'EPIPE'} up the pipe so the producer stops.
  const stdinCh = new MessageChannel();
  const { guest } = makeGuest({ 0: stdinCh.port1 });
  stdinCh.port2.start?.();

  const upstream: unknown[] = [];
  stdinCh.port2.onmessage = (e) => upstream.push(e.data);

  guest.exit(0);

  await new Promise(r => setTimeout(r, 10));
  expect(upstream.some(m => (m as { type?: string; code?: string }).type === 'error'
    && (m as { code?: string }).code === 'EPIPE')).toBe(true);

  stdinCh.port2.close();
});

test('Seam 2: exit() with no stdin port is a no-op (does not throw)', () => {
  const { guest } = makeGuest(); // no preopen ports
  expect(() => guest.exit(0)).not.toThrow();
});

test('M-Fix 1: dom/event kernel event reaches a guest onDomEvent listener', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const received: Array<{ nodeId: number; eventType: string; payload?: unknown }> = [];
  guest.onDomEvent!((e) => received.push(e));

  kernelPort.postMessage({
    event: 'dom/event',
    payload: { nodeId: 50, eventType: 'click', payload: {} },
  });

  await new Promise((r) => setTimeout(r, 20));
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ nodeId: 50, eventType: 'click' });

  kernelPort.close();
});

test('M-Fix 1: a malformed dom/event is ignored (no listener invoked, no throw)', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();
  const received: unknown[] = [];
  guest.onDomEvent!((e) => received.push(e));

  // Missing nodeId / wrong type — must be dropped.
  kernelPort.postMessage({ event: 'dom/event', payload: { eventType: 'click' } });
  kernelPort.postMessage({ event: 'dom/event', payload: { nodeId: 'x', eventType: 'click' } });

  await new Promise((r) => setTimeout(r, 20));
  expect(received).toHaveLength(0);
  kernelPort.close();
});

test('M-Fix 1: dom/event routes through MutationSerializer to the matching VNode listener', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const serializer = new MutationSerializer(guest);
  const button = serializer.createElement('div');
  const clicks: string[] = [];
  // B4: VNode is a real EventTarget; the listener gets a standard Event whose
  // target is the node and whose detail carries the forwarded payload.
  button.addEventListener('click', (e) => { clicks.push(e.type); });

  // Host forwards a click on this node's id.
  kernelPort.postMessage({
    event: 'dom/event',
    payload: { nodeId: button.id, eventType: 'click', payload: {} },
  });

  await new Promise((r) => setTimeout(r, 20));
  expect(clicks).toEqual(['click']);

  // An event for a different node id must NOT reach this listener.
  kernelPort.postMessage({
    event: 'dom/event',
    payload: { nodeId: button.id + 999, eventType: 'click', payload: {} },
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(clicks).toHaveLength(1);

  kernelPort.close();
});

test('B5: guest.pipe() surfaces transferred read/write ends as usable streams', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // Kernel side: mint a MessageChannel and transfer BOTH ends with the response,
  // exactly as SyscallDispatcher.#pipe does.
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number; call: string };
    if (req.call !== 'fs/pipe') return;
    const pipe = new MessageChannel();
    kernelPort.postMessage(
      { id: req.id, ok: true, result: { readfd: 3, writefd: 4 } },
      [pipe.port1, pipe.port2],
    );
  };

  const { readfd, writefd, readable, writable } = await guest.pipe();
  expect(readfd).toBe(3);
  expect(writefd).toBe(4);
  expect(readable).toBeInstanceOf(ReadableStream);
  expect(writable).toBeInstanceOf(WritableStream);

  // The two transferred ends are entangled (writePort → readPort), so bytes
  // written to `writable` arrive on `readable` over the credit-windowed protocol.
  const w = writable!.getWriter();
  const r = readable!.getReader();
  await w.write(new TextEncoder().encode('round-trip'));
  const { value } = await r.read();
  expect(new TextDecoder().decode(value)).toBe('round-trip');

  kernelPort.close();
});

test('B3: guest.fs is a directory-handle-shaped root that drives fs/* over the control port', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  // A minimal kernel fs over the control port: a single in-memory file.
  let fileData = new Uint8Array();
  const fds = new Map<number, { write: boolean }>();
  let nextFd = 3;
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number; call: string; args: Record<string, unknown> };
    if (req.id == null) return;
    const reply = (result: unknown): void => { kernelPort.postMessage({ id: req.id, ok: true, result }); };
    switch (req.call) {
      case 'fs/open': {
        const fd = nextFd++;
        const oflags = (req.args.oflags ?? {}) as { write?: boolean; truncate?: boolean };
        if (oflags.truncate) fileData = new Uint8Array();
        fds.set(fd, { write: Boolean(oflags.write) });
        reply({ fd });
        break;
      }
      case 'fs/write': {
        const data = req.args.data as Uint8Array;
        const merged = new Uint8Array(fileData.byteLength + data.byteLength);
        merged.set(fileData, 0); merged.set(data, fileData.byteLength);
        fileData = merged;
        reply({ written: data.byteLength });
        break;
      }
      case 'fs/read': {
        reply(fileData);
        fileData = new Uint8Array(); // simple EOF-after-one-read for the test
        break;
      }
      case 'fs/stat': reply({ type: 'file', size: fileData.byteLength }); break;
      case 'fs/close': reply({}); break;
      default: kernelPort.postMessage({ id: req.id, ok: false, error: { code: 'ENOSYS', message: req.call } });
    }
  };

  const root = await guest.fs.getDirectory();
  expect(root.kind).toBe('directory');
  expect(root.name).toBe('');

  const fh = await root.getFileHandle('note.txt', { create: true });
  expect(fh.kind).toBe('file');
  const w = await fh.createWritable();
  await w.write('persisted');
  await w.close();

  const file = await fh.getFile();
  expect(await file.text()).toBe('persisted');

  // The StorageManager object is memoized (lazy mint).
  expect(guest.fs).toBe(guest.fs);

  kernelPort.close();
});

test('Q1: guest.fs is a StorageManager — getDirectory()=root, getCurrentDirectory()=cwd', async () => {
  const ctrl = new MessageChannel();
  const guest = createGuest({
    control: ctrl.port2,
    init: {
      type: 'init', entry: 'inline', args: ['prog'], env: {},
      cwd: '/work', pid: 9, ppid: 0, capabilities: [],
    },
  });
  const kernelPort = ctrl.port1;
  kernelPort.start?.();

  // A tiny in-memory kernel fs over the control port (path → bytes/dir).
  type Node = { type: 'file'; data: Uint8Array } | { type: 'directory' };
  const tree = new Map<string, Node>([['/', { type: 'directory' }], ['/work', { type: 'directory' }]]);
  const fds = new Map<number, { path: string; offset: number }>();
  let nextFd = 3;
  const norm = (p: string): string => '/' + p.split('/').filter(Boolean).join('/');
  kernelPort.onmessage = (e) => {
    const req = e.data as { id?: number; call: string; args: Record<string, unknown> };
    if (req.id == null) return;
    const ok = (result: unknown): void => { kernelPort.postMessage({ id: req.id, ok: true, result }); };
    const err = (code: string): void => { kernelPort.postMessage({ id: req.id, ok: false, error: { code, message: code } }); };
    const path = typeof req.args.path === 'string' ? norm(req.args.path) : '';
    switch (req.call) {
      case 'fs/stat': {
        const node = tree.get(path);
        if (!node) return err('ENOENT');
        ok({ type: node.type, size: node.type === 'file' ? node.data.byteLength : 0 });
        break;
      }
      case 'fs/mkdir': tree.set(path, { type: 'directory' }); ok({}); break;
      case 'fs/open': {
        const oflags = (req.args.oflags ?? {}) as { create?: boolean; truncate?: boolean };
        let node = tree.get(path);
        if (!node) {
          if (!oflags.create) return err('ENOENT');
          node = { type: 'file', data: new Uint8Array() };
          tree.set(path, node);
        } else if (node.type === 'file' && oflags.truncate) {
          node.data = new Uint8Array();
        }
        const fd = nextFd++;
        fds.set(fd, { path, offset: 0 });
        ok({ fd });
        break;
      }
      case 'fs/read': {
        const ent = fds.get(Number(req.args.fd))!;
        const node = tree.get(ent.path) as { type: 'file'; data: Uint8Array };
        const slice = node.data.subarray(ent.offset);
        ent.offset += slice.byteLength;
        ok(new Uint8Array(slice));
        break;
      }
      case 'fs/write': {
        const ent = fds.get(Number(req.args.fd))!;
        const node = tree.get(ent.path) as { type: 'file'; data: Uint8Array };
        const data = req.args.data as Uint8Array;
        const merged = new Uint8Array(node.data.byteLength + data.byteLength);
        merged.set(node.data, 0); merged.set(data, node.data.byteLength);
        node.data = merged;
        ok({ written: data.byteLength });
        break;
      }
      case 'fs/close': fds.delete(Number(req.args.fd)); ok({}); break;
      default: err('ENOSYS');
    }
  };

  const root = await guest.fs.getDirectory();
  expect(root.kind).toBe('directory');

  const cwd = await guest.fs.getCurrentDirectory();
  expect(cwd.name).toBe('work');
  const fh = await cwd.getFileHandle('out.txt', { create: true });
  const w = await fh.createWritable();
  await w.write(new TextEncoder().encode('hi'));
  await w.close();

  // reachable from root by absolute walk
  const back = await (await (await root.getDirectoryHandle('work')).getFileHandle('out.txt')).getFile();
  expect(await back.text()).toBe('hi');

  kernelPort.close();
});

test('B2: guest.fetch round-trips a net/fetch over the control port to a real Response', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const enc = new TextEncoder();
  const seen: Array<{ call: string; args: Record<string, unknown> }> = [];
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number; call: string; args: Record<string, unknown> };
    if (req.id != null && req.call === 'net/fetch') {
      seen.push({ call: req.call, args: req.args });
      kernelPort.postMessage({
        id: req.id, ok: true,
        result: { status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: enc.encode('pong') },
      });
    }
  };

  const res = await guest.fetch('http://api/ping', { method: 'POST', body: 'ping' });
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/plain');
  expect(await res.text()).toBe('pong');

  expect(seen).toHaveLength(1);
  expect(seen[0].args.method).toBe('POST');
  expect(seen[0].args.url).toBe('http://api/ping');

  kernelPort.close();
});

test('syscall response is NOT delivered to the signal handler', async () => {
  const { guest, kernelPort } = makeGuest();
  kernelPort.start?.();

  const signals: string[] = [];
  guest.onSignal((sig) => signals.push(sig));

  // Reply immediately to the syscall.
  kernelPort.onmessage = (e) => {
    const req = e.data as { id: number };
    if (req.id != null) {
      kernelPort.postMessage({ id: req.id, ok: true, result: {} });
    }
  };

  await guest.syscall('op/noop', {});

  await new Promise(r => setTimeout(r, 10));
  expect(signals).toEqual([]);

  kernelPort.close();
});

test('guest.isatty reflects the preopen tty flags', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [],
      preopens: { 0: { type: 'pipe', tty: true }, 1: { type: 'pipe', tty: true }, 2: { type: 'pipe', tty: false } },
    },
    preopenPorts: {},
  });
  expect(guest.isatty(0)).toBe(true);
  expect(guest.isatty(1)).toBe(true);
  expect(guest.isatty(2)).toBe(false);
  // Unknown fd → false (POSIX: not a tty).
  expect(guest.isatty(3)).toBe(false);
  guest.exit(0);
});

test('guest.isatty is false when preopens omit tty (default pipe)', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [],
      preopens: { 0: { type: 'pipe' }, 1: { type: 'pipe' }, 2: { type: 'pipe' } },
    },
    preopenPorts: {},
  });
  expect(guest.isatty(0)).toBe(false);
  expect(guest.isatty(1)).toBe(false);
  guest.exit(0);
});

test('guest.isatty is false when init.preopens is entirely absent', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 3, ppid: 0, capabilities: [] },
    preopenPorts: {},
  });
  expect(guest.isatty(0)).toBe(false);
  expect(guest.isatty(1)).toBe(false);
  expect(guest.isatty(2)).toBe(false);
  guest.exit(0);
});

test('guest.display surfaces the boot DisplayInfo (available:true + geometry)', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [],
      display: { available: true, mode: 'window', width: 480, height: 360, title: 'Pic' },
    },
    preopenPorts: {},
  });
  expect(guest.display?.available).toBe(true);
  expect(guest.display?.mode).toBe('window');
  expect(guest.display?.width).toBe(480);
  expect(guest.display?.height).toBe(360);
  expect(guest.display?.title).toBe('Pic');
  guest.exit(0);
});

test('guest.display surfaces available:false for a no-GUI (hidden/headless) surface', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [],
      display: { available: false },
    },
    preopenPorts: {},
  });
  expect(guest.display?.available).toBe(false);
  expect(guest.display?.width).toBeUndefined();
  guest.exit(0);
});

test('guest.display is undefined for a headless/no-display process', () => {
  const ch = new MessageChannel();
  const guest = createGuest({
    control: ch.port1,
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 3, ppid: 0, capabilities: [] },
    preopenPorts: {},
  });
  expect(guest.display).toBeUndefined();
  guest.exit(0);
});
