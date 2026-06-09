export class AsyncNodeStdinHandler {
  #ended = false;

  blockingRead(len: number): Promise<Uint8Array> | Uint8Array {
    if (this.#ended) return new Uint8Array(0);

    const chunk = process.stdin.read(Math.min(len, process.stdin.readableLength || len));
    if (chunk) return new Uint8Array(chunk);

    return new Promise<Uint8Array>((resolve, reject) => {
      const onReadable = () => {
        const data = process.stdin.read(Math.min(len, process.stdin.readableLength || len));
        if (data) {
          cleanup();
          resolve(new Uint8Array(data));
        }
      };
      const onEnd = () => {
        cleanup();
        this.#ended = true;
        resolve(new Uint8Array(0));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        process.stdin.removeListener('readable', onReadable);
        process.stdin.removeListener('end', onEnd);
        process.stdin.removeListener('error', onError);
      };
      process.stdin.on('readable', onReadable);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);
    });
  }
}

export class AsyncNodeStdoutHandler {
  write(data: Uint8Array): void {
    process.stdout.write(data);
  }

  flush(): void {
    // Node.js stdout is auto-flushed for TTY, buffered for pipes but flush is sync
  }
}

export class AsyncNodeStderrHandler {
  write(data: Uint8Array): void {
    process.stderr.write(data);
  }

  flush(): void {}
}
