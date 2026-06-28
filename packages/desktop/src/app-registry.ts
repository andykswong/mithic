import type { Capability } from '@mithic/protocol';
import type { AppDescriptor } from './types.ts';

/**
 * The set of installed apps + file-type associations. Pure data + lookups; the
 * WindowManager consumes it to launch apps and resolve "Open With".
 */
export class AppRegistry {
  readonly #apps = new Map<string, AppDescriptor>();
  /** lowercase extension (no dot) → app name */
  readonly #assoc = new Map<string, string>();

  register(app: AppDescriptor): void {
    const hasMount = typeof app.mount === 'function';
    const hasEntry = app.entry != null;
    if (hasMount === hasEntry) {
      throw new Error(`app "${app.name}" must declare exactly one of \`mount\` or \`entry\``);
    }
    if (this.#apps.has(app.name)) {
      throw new Error(`app already registered: ${app.name}`);
    }
    this.#apps.set(app.name, app);
  }

  get(name: string): AppDescriptor | undefined {
    return this.#apps.get(name);
  }

  list(): AppDescriptor[] {
    return [...this.#apps.values()];
  }

  /** Associate a file extension (with or without leading dot) to an app name. */
  associate(ext: string, appName: string): void {
    this.#assoc.set(normalizeExt(ext), appName);
  }

  /** Resolve the app that should open `path`, by its extension. */
  resolveForFile(path: string): AppDescriptor | undefined {
    const ext = extOf(path);
    if (!ext) return undefined;
    const name = this.#assoc.get(ext);
    return name ? this.#apps.get(name) : undefined;
  }
}

/** The subset of an app `manifest.json` the desktop consumes. */
export interface AppManifest {
  name: string;
  title?: string;
  icon?: string;
  display?: { mode?: 'window' | 'fullscreen' | 'hidden'; defaultSize?: [number, number] };
  capabilities?: {
    fs?: { paths: string[]; operations: ('read' | 'write' | 'execute')[] };
    net?: { origins: string[] };
    ipc?: { channels: string[] };
    process?: { maxChildren?: number };
    env?: boolean;
  };
}

/** Extra fields the host supplies that don't live in a manifest (the code hook + UI bits). */
export interface AppDescriptorExtras {
  entry?: string | URL;
  mount?: AppDescriptor['mount'];
  icon?: string;
}

/** Default window size used when a manifest declares no `display.defaultSize`. */
const DEFAULT_MANIFEST_SIZE: [number, number] = [640, 480];

/**
 * Flatten a manifest's nested `capabilities` OBJECT to the flat `Capability[]`
 * the kernel checks. This is the single source of truth for the manifest →
 * grant conversion — exec-from-VFS install writes the result into a utility's
 * `security.capability` xattr, and {@link appDescriptorFromManifest} uses it for
 * desktop spawns. A manifest with no `capabilities` yields `[]` (default-deny).
 */
export function manifestCapabilities(manifest: AppManifest): Capability[] {
  const caps: Capability[] = [];
  const c = manifest.capabilities ?? {};
  if (c.fs) caps.push({ type: 'fs', paths: c.fs.paths, operations: c.fs.operations });
  if (c.net) caps.push({ type: 'net', origins: c.net.origins });
  if (c.ipc) caps.push({ type: 'ipc', channels: c.ipc.channels });
  if (c.process) caps.push({ type: 'process', maxChildren: c.process.maxChildren });
  if (c.env) caps.push({ type: 'env' });
  return caps;
}

/**
 * Build an {@link AppDescriptor} from an app `manifest.json` + the host's code
 * hook (`entry` for a tier-2 sandboxed guest, or `mount` for a tier-1 host-DOM
 * app). The manifest's nested `capabilities` OBJECT is converted to the flat
 * `Capability[]` the kernel checks. `display.mode`/`defaultSize` become
 * `displayMode`/`defaultSize` (the WM threads `displayMode` into the guest's
 * `guest.display`). An `extras.icon` overrides the manifest icon.
 */
export function appDescriptorFromManifest(
  manifest: AppManifest,
  extras: AppDescriptorExtras,
): AppDescriptor {
  const caps = manifestCapabilities(manifest);
  return {
    name: manifest.name,
    title: manifest.title ?? manifest.name,
    icon: extras.icon ?? manifest.icon,
    defaultSize: manifest.display?.defaultSize ?? DEFAULT_MANIFEST_SIZE,
    displayMode: manifest.display?.mode ?? 'window',
    capabilities: caps,
    entry: extras.entry,
    mount: extras.mount,
  };
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

function extOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined; // no ext, or dotfile with no ext
  return base.slice(dot + 1).toLowerCase();
}
