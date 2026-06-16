/**
 * Host-side command registry + in-process kernel launcher.
 *
 * THE BROWSER LOADING PROBLEM. The production resolvers
 * (`createCoreutilsResolver` / `createJqResolver` / `createCurlResolver`) map a
 * command name to the `file://` URL of its built `dist` guest module. The kernel's
 * default launcher then `await import(url)`s that module inside a Worker (or an
 * opaque-origin iframe). That works in Node (the launcher's in-process branch
 * resolves the module's bare `@mithic/guest-runtime` import via node_modules), but
 * in a browser the Worker/iframe is a bare, un-transformed module context: the
 * transitive `import { createGuest } from '@mithic/guest-runtime'` fails to resolve
 * and the guest never boots.
 *
 * THE FIX. This example does NOT spawn guests by URL. Instead the host page
 * statically imports every command's guest module through the BUNDLER (Vite via
 * `import.meta.glob`, so `@mithic/guest-runtime` is resolved/inlined at build
 * time), keyed by command name. The shell's `resolveCommand` maps a name to a
 * sentinel `command:<name>` URL; a custom kernel {@link GuestLauncher}
 * ({@link InProcessCommandLauncher}) recognizes that sentinel and runs the
 * pre-imported guest default IN-PROCESS, against the kernel's boot wiring (the
 * same `{ control, init, preopenPorts }` shape the kernel's own in-process
 * launcher uses). No Worker, no iframe, no URL import — so it runs identically in
 * the browser, under vitest's Chromium, and in Node.
 */
import type { GuestLauncher, LaunchContext } from '@mithic/kernel';
import type { Runtime, ProcessHandle } from '@mithic/runtime';

/** A guest module's default export — the function the kernel boots. */
type GuestDefault = (boot: unknown) => unknown | Promise<unknown>;

/** Sentinel URL scheme the resolver emits and the launcher recognizes. */
const COMMAND_SCHEME = 'command:';

/**
 * Build the name → guest-default map by globbing each command package's built
 * `dist` guest modules. `import.meta.glob` is resolved by Vite at build time
 * (dev server, `vite build`, and `vitest --project browser` all run under Vite),
 * so each module — and its `@mithic/guest-runtime` dependency — is bundled into
 * the host's module graph. The keys are absolute glob paths; we derive the bare
 * command name from the filename.
 */
function buildRegistry(): Map<string, () => Promise<GuestDefault>> {
  const registry = new Map<string, () => Promise<GuestDefault>>();

  // Each command package builds 1:1 modules (preserveModules): coreutils ->
  // dist/commands/<name>.js, jq -> dist/jq.js, curl -> dist/curl.js. Glob them
  // relative to this file. `eager: false` yields lazy loader functions.
  const modules: Record<string, () => Promise<unknown>> = {
    ...import.meta.glob('../../../coreutils/dist/commands/*.js'),
    ...import.meta.glob('../../../commands/jq/dist/jq.js'),
    ...import.meta.glob('../../../commands/curl/dist/curl.js'),
  };

  for (const [path, load] of Object.entries(modules)) {
    const file = path.slice(path.lastIndexOf('/') + 1); // e.g. cat.js
    const name = file.replace(/\.js$/, '');
    // Skip the private helper modules coreutils ships alongside commands
    // (`_regex`, `_test-io`, …) — they are not commands.
    if (name.startsWith('_')) continue;
    registry.set(name, async () => {
      const mod = (await load()) as { default: GuestDefault };
      return mod.default;
    });
  }
  return registry;
}

/**
 * The composed command suite. `names` is every resolvable command; `resolve`
 * maps a known name to its `command:<name>` sentinel URL (or `undefined` →
 * ENOENT, the shell's "command not found"); `launcher` is the kernel launcher
 * that runs a resolved sentinel in-process.
 */
export interface CommandSuite {
  names: string[];
  resolve(name: string): URL | undefined;
  launcher: GuestLauncher;
}

/**
 * Assemble the in-process command suite: a composed coreutils + jq + curl
 * resolver and the launcher that runs them. Pass `resolve` as the shell
 * executor's `resolve` (name -> sentinel) and `launcher` to `new Kernel({ launcher })`.
 */
export function createCommandSuite(): CommandSuite {
  const registry = buildRegistry();

  const resolve = (name: string): URL | undefined =>
    registry.has(name) ? new URL(COMMAND_SCHEME + name) : undefined;

  const launcher = new InProcessCommandLauncher(registry);

  return { names: [...registry.keys()].sort(), resolve, launcher };
}

/**
 * Kernel launcher that boots a registered command guest IN-PROCESS. For a
 * `command:<name>` sentinel it looks up the pre-imported guest default and
 * invokes it with the kernel's boot object (control + stdio ports). For any
 * other code (a real string/URL) it has no guest to run — those paths are not
 * used by this example.
 */
export class InProcessCommandLauncher implements GuestLauncher {
  readonly #registry: Map<string, () => Promise<GuestDefault>>;

  constructor(registry: Map<string, () => Promise<GuestDefault>>) {
    this.#registry = registry;
  }

  async launch(_runtime: Runtime, ctx: LaunchContext): Promise<ProcessHandle> {
    const href = ctx.code instanceof URL ? ctx.code.href : String(ctx.code);
    if (!href.startsWith(COMMAND_SCHEME)) {
      throw new Error(`InProcessCommandLauncher: cannot launch non-command code: ${href}`);
    }
    const name = href.slice(COMMAND_SCHEME.length);
    const load = this.#registry.get(name);
    if (!load) throw Object.assign(new Error(`command not found: ${name}`), { code: 'ENOENT' });

    // Reserve a handle id (the kernel uses it for kill()/onMessage()).
    const handle: ProcessHandle = { id: ctx.init.pid };
    const preopenPorts: Record<number, MessagePort> = {};
    ctx.stdio.forEach((port, i) => { if (port != null) preopenPorts[i] = port; });
    const boot = { control: ctx.control, init: ctx.init, preopenPorts };

    const guestDefault = await load();
    // Fire-and-forget: the guest drives itself and signals exit over `control`.
    void Promise.resolve(guestDefault(boot)).catch(() => { /* crash surfaces via exit */ });
    return handle;
  }

  kill(): void { /* in-process guest cannot be force-killed; it exits on its own */ }
}
