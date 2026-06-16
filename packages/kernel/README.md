# @mithic/kernel

The Mithic kernel: a singleton that ties together process lifecycle, IPC,
capabilities, and syscall dispatch over a pluggable runtime backend. It is the
trust boundary — every guest syscall is routed through the kernel's dispatcher,
where capability checks run, regardless of which backend the guest runs on.

## Responsibilities

- **Process lifecycle** — `spawn`, `wait`, `kill`, pid allocation, reaping.
- **IPC** — mints credit-based pipes; wires zero-hop guest→guest pipelines.
- **Capabilities** — grants and narrows capabilities against the parent process.
- **Syscall dispatch** — VFS (`fs/*`), process, IPC, and optional `dom/mutate`.
- **GUI** — threads `display` placement to the runtime; hosts Remote DOM.

## Quick start

```ts
import { Kernel } from '@mithic/kernel';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

const vfs = new FileSystemRouter();
await vfs.mount('/', new MemoryFsProvider());

const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

// Spawn a guest module (inline source string or a module URL).
const { pid, stdout } = await kernel.spawn(guestCode, {
  args: ['prog'],
  capabilities: [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }],
  captureStdout: true,
  display: { mode: 'inline', width: 800, height: 600 }, // GUI placement (iframe runtime)
});

const { code } = await kernel.wait(pid);
const out = new TextDecoder().decode(await stdout!);
```

### Pipelines

```ts
// cmd1 | cmd2 | cmd3 — stages run concurrently, connected by zero-hop pipes.
const { exitCodes, lastStdout } = await kernel.runPipeline([
  { code: cmd1 },
  { code: cmd2 },
  { code: cmd3, captureStdout: true },
]);
```

The guest side of this protocol lives in `@mithic/guest-runtime` (`createGuest`).
