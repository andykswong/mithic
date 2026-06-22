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

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

function extOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined; // no ext, or dotfile with no ext
  return base.slice(dot + 1).toLowerCase();
}
