import type { Capability } from '@mithic/protocol';
import { normalizePath } from '@mithic/io/vfs';

export type FsOperation = 'read' | 'write' | 'execute';

/**
 * Per-process capability store with narrow-only delegation.
 *
 * Capabilities are a discriminated union (fs | net | ipc | process | env).
 * Children may only receive a subset of their parent's grants — `narrow()`
 * throws if a requested capability exceeds what the parent holds.
 */
export class CapabilityManager {
  #grants = new Map<number, Capability[]>();

  /** Replace the capability set granted to a process. */
  grant(pid: number, caps: Capability[]): void {
    this.#grants.set(pid, caps.map(cloneCapability));
  }

  /** Drop all capabilities held by a process. */
  revoke(pid: number): void {
    this.#grants.delete(pid);
  }

  /** Return a process's current capabilities (defensive copy). */
  capabilities(pid: number): Capability[] {
    return (this.#grants.get(pid) ?? []).map(cloneCapability);
  }

  /**
   * Check filesystem access via longest-prefix path match. The matching `fs`
   * capability must also list the requested operation.
   *
   * Internally normalizes `absPath` (collapses `..`/`.` segments) before
   * prefix-matching so callers cannot escape grants via path traversal.
   */
  checkFs(pid: number, absPath: string, op: FsOperation): boolean {
    const normalized = normalizePath(absPath);
    let best: { len: number; ops: FsOperation[] } | undefined;
    for (const cap of this.#grants.get(pid) ?? []) {
      if (cap.type !== 'fs') continue;
      for (const granted of cap.paths) {
        const prefix = normalizePath(normalize(granted));
        if (pathHasPrefix(normalized, prefix) && (!best || prefix.length > best.len)) {
          best = { len: prefix.length, ops: cap.operations };
        }
      }
    }
    return best !== undefined && best.ops.includes(op);
  }

  /** Check network access by exact origin match against the request URL. */
  checkNet(pid: number, url: string): boolean {
    const origin = originOf(url);
    if (origin === undefined) return false;
    for (const cap of this.#grants.get(pid) ?? []) {
      if (cap.type !== 'net') continue;
      for (const allowed of cap.origins) {
        if (originOf(allowed) === origin || allowed === origin) return true;
      }
    }
    return false;
  }

  /** Check IPC access by exact channel match. */
  checkIpc(pid: number, channel: string): boolean {
    for (const cap of this.#grants.get(pid) ?? []) {
      if (cap.type !== 'ipc') continue;
      if (cap.channels.includes(channel)) return true;
    }
    return false;
  }

  /**
   * Validate that `requested` is a subset of the parent's grants and return it
   * (cloned). Throws if any requested capability exceeds the parent's.
   */
  narrow(parentPid: number, requested: Capability[]): Capability[] {
    const parent = this.#grants.get(parentPid) ?? [];
    for (const req of requested) {
      if (!isSubsetOfAny(req, parent)) {
        throw new Error(`Capability exceeds parent grant: ${JSON.stringify(req)}`);
      }
    }
    return requested.map(cloneCapability);
  }
}

function cloneCapability(cap: Capability): Capability {
  switch (cap.type) {
    case 'fs':
      return { type: 'fs', paths: [...cap.paths], operations: [...cap.operations] };
    case 'net':
      return { type: 'net', origins: [...cap.origins] };
    case 'ipc':
      return { type: 'ipc', channels: [...cap.channels] };
    case 'process':
      return { type: 'process', maxChildren: cap.maxChildren };
    case 'env':
      return { type: 'env' };
  }
}

/** True if `req` is fully covered by at least one capability in `grants`. */
function isSubsetOfAny(req: Capability, grants: Capability[]): boolean {
  switch (req.type) {
    case 'fs':
      return req.paths.every(path =>
        grants.some(g =>
          g.type === 'fs'
          && g.paths.some(gp => pathHasPrefix(normalize(path), normalize(gp)))
          && req.operations.every(op => g.operations.includes(op)),
        ),
      );
    case 'net':
      return req.origins.every(origin =>
        grants.some(g => g.type === 'net' && g.origins.includes(origin)),
      );
    case 'ipc':
      return req.channels.every(ch =>
        grants.some(g => g.type === 'ipc' && g.channels.includes(ch)),
      );
    case 'process':
      return grants.some(g =>
        g.type === 'process'
        && (g.maxChildren === undefined
          || (req.maxChildren !== undefined && req.maxChildren <= g.maxChildren)),
      );
    case 'env':
      return grants.some(g => g.type === 'env');
  }
}

/** Strip trailing slash (except root) so prefix checks are well-defined. */
function normalize(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.replace(/\/+$/, '');
  return path;
}

/** True if `path` is at or beneath `prefix` on a path-component boundary. */
function pathHasPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(prefix + '/');
}

/** Extract the origin (scheme://host:port) from a URL, or undefined if invalid. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
