import type { FdAction } from '@mithic/protocol';
import { PipeReader, INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import { normalizePath } from '@mithic/io/vfs';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';
import type { IpcBroker } from './ipc-broker.ts';
import type { SpawnInit } from './kernel.ts';
import { pumpToPort } from './pump.ts';

/**
 * C3 — wires a child process's file descriptors for `process/spawn`'s `fds`
 * actions, lifted out of the Kernel as a focused strategy (the original
 * `#applyFdAction` already took everything by param). It mutates the child's
 * {@link SpawnInit} to attach the guest-side preopen port for each fd and pushes
 * the parent-facing pipe ports into the caller's `transfer`/`pipes` accumulators.
 * VFS-file `open` actions are deferred as `filePumps` the kernel starts AFTER the
 * child spawns (so the child's read end has a reader granting credit before bytes
 * flow). The kernel composes one instance and calls {@link applyAction} per fd.
 */
export class FdWiring {
  #ipc: IpcBroker;
  #caps: CapabilityManager;
  #vfs: FileSystemProvider;

  constructor(ipc: IpcBroker, caps: CapabilityManager, vfs: FileSystemProvider) {
    this.#ipc = ipc;
    this.#caps = caps;
    this.#vfs = vfs;
  }

  /**
   * K2: apply a single {@link FdAction} for the child's `fd`, mutating `init` to
   * wire the child-side preopen port and pushing parent-facing pipe ports into
   * `transfer`/`pipes`. Supports all fds (0-2 and >= 3).
   *
   *   - `pipe`  — mint a fresh pipe. The child gets the guest-side end (fd 0 →
   *               read end, else write end); the OTHER end is transferred back to
   *               the parent.
   *   - `dup2`  — inject a guest-supplied port at this fd (zero-hop pipe).
   *   - `open`  — open the VFS `path` (checked against the parent's fs cap) and
   *               pump it: READ feeds the file into the child's read end; WRITE
   *               drains the child's write end into the file.
   *   - `inherit`/`close`/default — default kernel-owned stdio (or an injected
   *               port already present for this fd).
   */
  async applyAction(
    parentPid: number,
    fd: number,
    action: FdAction,
    init: SpawnInit,
    injectedPorts: Map<number, MessagePort>,
    transfer: Transferable[],
    pipes: Record<number, 'transferred'>,
    filePumps: Array<() => void>,
  ): Promise<void> {
    switch (action.action) {
      case 'pipe': {
        const pipe = this.#ipc.createPipe();
        if (fd === 0) {
          // Child reads: child gets the read end; parent gets the write end.
          this.#wireChildFd(init, fd, pipe.readPort);
          transfer.push(pipe.writePort);
        } else {
          // Child writes (fd 1/2 or any fd >= 3 by convention): child gets the
          // write end; parent gets the read end to drain.
          this.#wireChildFd(init, fd, pipe.writePort);
          transfer.push(pipe.readPort);
        }
        pipes[fd] = 'transferred';
        break;
      }
      case 'dup2': {
        // The guest injected a port it owns for this fd (port-based dup2).
        const port = injectedPorts.get(fd);
        if (!port) break; // No port supplied: leave unwired (close-like).
        this.#wireChildFd(init, fd, port);
        break;
      }
      case 'open': {
        // K2: open a VFS file into the child fd. Capability-checked against the
        // PARENT's fs grants (the child can hold no more than the parent).
        const cwd = init.cwd ?? '/';
        const path = action.path.startsWith('/')
          ? normalizePath(action.path)
          : normalizePath(cwd.endsWith('/') ? cwd + action.path : cwd + '/' + action.path);
        const writing = Boolean(
          action.flags.write || action.flags.create || action.flags.truncate || action.flags.append,
        );
        const op: FsOperation = writing ? 'write' : 'read';
        if (!this.#caps.checkFs(parentPid, path, op)) {
          throw Object.assign(
            new Error(`process/spawn: open fd ${fd}: permission denied: ${path}`),
            { errno: 'EACCES' as const },
          );
        }
        const handle = await this.#vfs.open(path, action.flags as OpenFlags);
        const pipe = this.#ipc.createPipe();
        if (writing) {
          // Child WRITES the fd → child gets the write end; the kernel drains the
          // read end into the VFS file (offset advancing from 0).
          this.#wireChildFd(init, fd, pipe.writePort);
          filePumps.push(() => { void this.#drainPortToFile(pipe.readPort, handle); });
        } else {
          // Child READS the fd → child gets the read end; the kernel feeds the
          // file's bytes into the write end then closes (EOF).
          this.#wireChildFd(init, fd, pipe.readPort);
          filePumps.push(() => { void this.#feedFileToPort(handle, pipe.writePort); });
        }
        break;
      }
      case 'bytes': {
        // R1: feed an in-memory byte buffer into the child's read end (the
        // here-string/here-doc byte source — no VFS file backing it). fd 0 only
        // by convention (the only fd a guest reads a buffer from); other fds fall
        // through to default. Same chunked, credit-windowed pump as `open` read.
        const pipe = this.#ipc.createPipe();
        this.#wireChildFd(init, fd, pipe.readPort);
        filePumps.push(() => { void this.#feedBytesToPort(action.data, pipe.writePort); });
        break;
      }
      case 'inherit':
      case 'close':
      default:
        // inherit/close: default kernel-owned stdio (spawn() mints a fresh pipe
        // for any fd not injected here). An injected port for this fd is wired.
        if (injectedPorts.has(fd)) {
          this.#wireChildFd(init, fd, injectedPorts.get(fd)!);
        }
        break;
    }
  }

  /**
   * Wire the child-side preopen port for `fd` into `init`. fds 0/1/2 use the
   * dedicated stdin/stdout/stderr slots; fds >= 3 go into `init.extraFds`.
   */
  #wireChildFd(init: SpawnInit, fd: number, port: MessagePort): void {
    if (fd === 0) init.stdin = port;
    else if (fd === 1) init.stdout = port;
    else if (fd === 2) init.stderr = port;
    else { (init.extraFds ??= {})[fd] = port; }
  }

  /**
   * K2: stream a VFS file's bytes into a pipe WRITE port (the child's read end),
   * honoring the credit protocol, then send EOF and close. Reads the file in
   * chunks so a large file does not buffer wholesale, delegating the credit/EOF
   * loop to the shared {@link pumpToPort}. Fire-and-forget; errors close the port
   * (the child sees EOF/EPIPE) and the file handle is always closed.
   */
  async #feedFileToPort(handle: FileHandle, writePort: MessagePort): Promise<void> {
    let offset = 0;
    const next = async (): Promise<Uint8Array | null> => {
      // Read the next chunk first so its size is known before reserving credit.
      const data = await this.#vfs.read(handle, offset, INITIAL_CREDIT_BYTES);
      if (data.byteLength === 0) return null; // EOF
      offset += data.byteLength;
      return data;
    };
    try {
      await pumpToPort(writePort, next, INITIAL_CREDIT_BYTES);
    } finally {
      try { await this.#vfs.close(handle); } catch { /* already closed */ }
    }
  }

  /**
   * R1: stream an in-memory byte buffer into a pipe WRITE port (the child's read
   * end), honoring the credit protocol, then send EOF and close. The shared
   * {@link pumpToPort} sub-chunks the buffer to the credit window so it never
   * reserves more than a reader can grant. Fire-and-forget; a broken pipe
   * (reader cancel/EPIPE) ends the pump promptly.
   */
  async #feedBytesToPort(data: Uint8Array, writePort: MessagePort): Promise<void> {
    let sent = false;
    // Hand the whole buffer to the pump once; it sub-chunks to the window itself.
    const next = (): Promise<Uint8Array | null> => {
      if (sent) return Promise.resolve(null);
      sent = true;
      return Promise.resolve(data);
    };
    await pumpToPort(writePort, next, INITIAL_CREDIT_BYTES);
  }

  /**
   * K2: drain a pipe READ port (the child's write end) into a VFS file, advancing
   * the write offset. Grants credit so the writer flows. On EOF closes the file.
   * Fire-and-forget; errors close the port and the file.
   */
  #drainPortToFile(readPort: MessagePort, handle: FileHandle): Promise<void> {
    return new Promise<void>((resolve) => {
      let offset = 0;
      let chain: Promise<unknown> = Promise.resolve();
      readPort.start?.();
      // C1: shared sliding-window reader policy (1 MiB window for file throughput).
      const flow = new PipeReader(1 << 20);
      readPort.postMessage({ type: 'credit', bytes: flow.open() });
      const finish = (): void => {
        chain = chain.then(() => this.#vfs.close(handle)).catch(() => { /* closed */ });
        try { readPort.close(); } catch { /* closed */ }
        resolve();
      };
      readPort.onmessage = (e: MessageEvent): void => {
        const msg = e.data as { type?: string; chunk?: Uint8Array };
        if (msg?.type === 'data' && msg.chunk) {
          const chunk = msg.chunk;
          const at = offset;
          offset += chunk.byteLength;
          flow.recordArrival(chunk.byteLength);
          chain = chain.then(() => this.#vfs.write(handle, chunk, at)).catch(() => { /* write failure */ });
          const grant = flow.replenish();
          if (grant > 0) readPort.postMessage({ type: 'credit', bytes: grant });
        } else if (msg?.type === 'end' || msg?.type === 'error') {
          finish();
        }
      };
    });
  }
}
