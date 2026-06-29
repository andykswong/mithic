/**
 * Per-mount sidecar metadata store.
 *
 * OPFS and Node `fs` cannot carry Mithic's extended attributes (and OPFS also
 * drops mode/mtime), so a provider that lacks native support persists them in a
 * single reserved JSON blob keyed by canonical path. xattr values are stored as
 * `number[]` because `Uint8Array` is not JSON-serializable.
 */
export interface PathMeta {
  mode?: number;
  mtime?: number;
  atime?: number;
  xattrs?: Record<string, number[]>;
}

/** A reader/writer pair the provider supplies for its backing store. */
export interface MetadataBacking {
  load(): Promise<string | undefined> | string | undefined;
  flush(json: string): Promise<void> | void;
}

export class MetadataStore {
  #backing: MetadataBacking;
  #data: Record<string, PathMeta> = {};
  #loaded = false;

  constructor(backing: MetadataBacking) {
    this.#backing = backing;
  }

  async load(): Promise<void> {
    const raw = await this.#backing.load();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.#data = parsed as Record<string, PathMeta>;
        }
      } catch {
        this.#data = {};
      }
    }
    this.#loaded = true;
  }

  async #ensureLoaded(): Promise<void> {
    if (!this.#loaded) await this.load();
  }

  async #flush(): Promise<void> {
    await this.#backing.flush(JSON.stringify(this.#data));
  }

  async getxattr(path: string, name: string): Promise<Uint8Array | undefined> {
    await this.#ensureLoaded();
    const value = this.#data[path]?.xattrs?.[name];
    return value ? Uint8Array.from(value) : undefined;
  }

  async setxattr(path: string, name: string, value: Uint8Array): Promise<void> {
    await this.#ensureLoaded();
    const meta = (this.#data[path] ??= {});
    (meta.xattrs ??= {})[name] = Array.from(value);
    await this.#flush();
  }

  async listxattr(path: string): Promise<string[]> {
    await this.#ensureLoaded();
    const xattrs = this.#data[path]?.xattrs;
    return xattrs ? Object.keys(xattrs) : [];
  }

  async removexattr(path: string, name: string): Promise<void> {
    await this.#ensureLoaded();
    const xattrs = this.#data[path]?.xattrs;
    if (xattrs && name in xattrs) {
      delete xattrs[name];
      await this.#flush();
    }
  }

  async getMeta(path: string): Promise<PathMeta | undefined> {
    await this.#ensureLoaded();
    return this.#data[path];
  }

  async setMode(path: string, mode: number): Promise<void> {
    await this.#ensureLoaded();
    (this.#data[path] ??= {}).mode = mode;
    await this.#flush();
  }

  async setTimes(path: string, atime: number, mtime: number): Promise<void> {
    await this.#ensureLoaded();
    const meta = (this.#data[path] ??= {});
    meta.atime = atime;
    meta.mtime = mtime;
    await this.#flush();
  }

  /**
   * Track a structural rename so metadata follows the entry. Prefix-aware: the
   * exact key AND every descendant under `oldPath + '/'` migrate to the new
   * subtree, and any pre-existing dest entry + subtree is cleared first so a
   * later same-named entry can't inherit stale (or forged) metadata.
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.#ensureLoaded();
    let changed = false;

    if (this.#deleteSubtree(newPath)) changed = true;

    const oldPrefix = oldPath + '/';
    const newPrefix = newPath + '/';
    for (const key of Object.keys(this.#data)) {
      if (key === oldPath) {
        this.#data[newPath] = this.#data[key];
        delete this.#data[key];
        changed = true;
      } else if (key.startsWith(oldPrefix)) {
        this.#data[newPrefix + key.slice(oldPrefix.length)] = this.#data[key];
        delete this.#data[key];
        changed = true;
      }
    }

    if (changed) await this.#flush();
  }

  /** Drop all metadata for a removed path. */
  async drop(path: string): Promise<void> {
    await this.#ensureLoaded();
    if (path in this.#data) {
      delete this.#data[path];
      await this.#flush();
    }
  }

  /** Drop the exact path AND every descendant under it (used by rmdir). */
  async dropSubtree(path: string): Promise<void> {
    await this.#ensureLoaded();
    if (this.#deleteSubtree(path)) {
      await this.#flush();
    }
  }

  #deleteSubtree(path: string): boolean {
    const prefix = path + '/';
    let changed = false;
    for (const key of Object.keys(this.#data)) {
      if (key === path || key.startsWith(prefix)) {
        delete this.#data[key];
        changed = true;
      }
    }
    return changed;
  }
}
