import { FileSystemRouter, type FileSystemProvider } from './vfs/index.ts';
import type { HttpClient, HttpServer } from './net/http.ts';
import { DisabledHttpClient } from './net/providers/disabled-http.ts';
import { type SocketProvider, DisabledSocketProvider } from './net/sockets.ts';

export interface IoContextOptions {
  /** VFS mount configuration: path -> provider. */
  vfs?: Record<string, FileSystemProvider>;
  /** HTTP client. Default: DisabledHttpClient. */
  http?: HttpClient;
  /** HTTP server (optional). */
  httpServer?: HttpServer;
  /** Socket provider. Default: DisabledSocketProvider. */
  sockets?: SocketProvider;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Command-line arguments. */
  args?: string[];
  /** Working directory. */
  cwd?: string;
}

export class IoContext {
  vfs: FileSystemRouter;
  readonly http: HttpClient;
  readonly httpServer?: HttpServer;
  readonly sockets: SocketProvider;
  readonly env: Map<string, string>;
  readonly args: string[];
  cwd: string;

  constructor(options?: IoContextOptions) {
    this.vfs = new FileSystemRouter();
    if (options?.vfs) {
      for (const [path, provider] of Object.entries(options.vfs)) {
        void this.vfs.mount(path, provider);
      }
    }
    this.http = options?.http ?? new DisabledHttpClient();
    this.httpServer = options?.httpServer;
    this.sockets = options?.sockets ?? new DisabledSocketProvider();
    this.env = new Map(Object.entries(options?.env ?? {}));
    this.args = options?.args ?? [];
    this.cwd = options?.cwd ?? '/';
  }

  /** Create a child context with overridden options (for process isolation). */
  fork(overrides?: Partial<IoContextOptions>): IoContext {
    const child = new IoContext({
      http: overrides?.http ?? this.http,
      httpServer: overrides?.httpServer ?? this.httpServer,
      sockets: overrides?.sockets ?? this.sockets,
      env: overrides?.env ?? Object.fromEntries(this.env),
      args: overrides?.args ?? [...this.args],
      cwd: overrides?.cwd ?? this.cwd,
    });
    // Share the same FileSystemRouter instance (with any additional mounts from overrides)
    child.vfs = this.vfs;
    if (overrides?.vfs) {
      for (const [path, provider] of Object.entries(overrides.vfs)) {
        void child.vfs.mount(path, provider);
      }
    }
    return child;
  }

  /** Dispose all providers. */
  async dispose(): Promise<void> {
    this.http.dispose?.();
    this.sockets.dispose?.();
    for (const [mountPoint] of this.vfs.getMounts()) {
      await this.vfs.unmount(mountPoint);
    }
  }
}
