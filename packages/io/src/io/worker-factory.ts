export interface ManagedWorker {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  on(event: 'message', handler: (msg: unknown) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit', handler: (code: number) => void): void;
  terminate(): Promise<number>;
}

export interface WorkerFactory {
  create(entryPoint: string | URL, options?: { workerData?: unknown; name?: string }): ManagedWorker;
}
