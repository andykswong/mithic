/**
 * Adapts a mithic VFS FileSystemRouter into just-bash's IFileSystem interface.
 * This allows just-bash to operate on the mithic virtual filesystem.
 */

import type { FileSystemRouter } from '@mithic/io/vfs';
import type { IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions } from 'just-bash';

export class VirtualFileSystem implements IFileSystem {
  #router: FileSystemRouter;
  #cwd: string;

  constructor(router: FileSystemRouter, cwd = '/') {
    this.#router = router;
    this.#cwd = cwd;
  }

  get cwd(): string {
    return this.#cwd;
  }

  set cwd(path: string) {
    this.#cwd = path;
  }

  #resolve(path: string): string {
    if (path.startsWith('/')) return path;
    return this.#cwd.endsWith('/') ? this.#cwd + path : this.#cwd + '/' + path;
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return path;
    return base.endsWith('/') ? base + path : base + '/' + path;
  }

  getAllPaths(): string[] {
    return [];
  }

  async readFile(path: string): Promise<string> {
    const resolved = this.#resolve(path);
    const stat = await this.#router.stat(resolved);
    const handle = await this.#router.open(resolved, { read: true });
    const data = await this.#router.read(handle, 0, Number(stat.size));
    await this.#router.close(handle);
    return new TextDecoder().decode(data);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resolved = this.#resolve(path);
    const stat = await this.#router.stat(resolved);
    const handle = await this.#router.open(resolved, { read: true });
    const data = await this.#router.read(handle, 0, Number(stat.size));
    await this.#router.close(handle);
    return data;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolve(path);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = await this.#router.open(resolved, { create: true, write: true, truncate: true });
    await this.#router.write(handle, data, 0);
    await this.#router.close(handle);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolve(path);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = await this.#router.open(resolved, { write: true, append: true, create: true });
    const stat = await this.#router.stat(resolved);
    await this.#router.write(handle, data, Number(stat.size));
    await this.#router.close(handle);
  }

  async exists(path: string): Promise<boolean> {
    return this.#router.exists(this.#resolve(path));
  }

  async stat(path: string): Promise<FsStat> {
    const s = await this.#router.stat(this.#resolve(path), { followSymlinks: true });
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      isSymbolicLink: false,
      mode: s.mode,
      size: Number(s.size),
      mtime: s.mtime,
    };
  }

  async lstat(path: string): Promise<FsStat> {
    const s = await this.#router.stat(this.#resolve(path), { followSymlinks: false });
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      isSymbolicLink: s.type === 'symlink',
      mode: s.mode,
      size: Number(s.size),
      mtime: s.mtime,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const resolved = this.#resolve(path);
    if (options?.recursive) {
      const parts = resolved.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        try { await this.#router.mkdir(current); } catch { /* directory may already exist */ }
      }
    } else {
      await this.#router.mkdir(resolved);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.#router.readdir(this.#resolve(path));
    return entries.map(e => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const entries = await this.#router.readdir(this.#resolve(path));
    return entries.map(e => ({
      name: e.name,
      isFile: e.type === 'file',
      isDirectory: e.type === 'directory',
      isSymbolicLink: e.type === 'symlink',
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const resolved = this.#resolve(path);
    const s = await this.#router.stat(resolved);
    if (s.type === 'directory') {
      if (options?.recursive) {
        const entries = await this.#router.readdir(resolved);
        for (const entry of entries) {
          const childPath = resolved.endsWith('/') ? resolved + entry.name : resolved + '/' + entry.name;
          await this.rm(childPath, { recursive: true });
        }
        await this.#router.rmdir(resolved);
      } else {
        await this.#router.rmdir(resolved);
      }
    } else {
      await this.#router.unlink(resolved);
    }
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const data = await this.readFileBuffer(src);
    await this.writeFile(dest, data);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.#router.rename(this.#resolve(src), this.#resolve(dest));
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.#router.chmod(this.#resolve(path), mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.#router.symlink(target, this.#resolve(linkPath));
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.#router.link(this.#resolve(existingPath), this.#resolve(newPath));
  }

  async readlink(path: string): Promise<string> {
    return this.#router.readlink(this.#resolve(path));
  }

  async realpath(path: string): Promise<string> {
    const resolved = this.#resolve(path);
    const { provider, relativePath, mountPoint } = this.#router.resolve(resolved);
    if (provider.realpath) {
      const result = await provider.realpath(relativePath);
      return mountPoint === '/'
        ? '/' + result.replace(/^\//, '')
        : mountPoint + '/' + result.replace(/^\//, '');
    }
    return resolved;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.#router.utimes(this.#resolve(path), atime, mtime);
  }
}
