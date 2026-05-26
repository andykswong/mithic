import { useCallback, useEffect, useRef, useState } from 'react';
import { IoLoop, createCallHandler } from '@mithic/io/io';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function App() {
  const workerRef = useRef<Worker | undefined>(undefined);
  const stdinQueueRef = useRef<Uint8Array[]>([]);
  const stdinResolveRef = useRef<((data: Uint8Array) => void) | null>(null);

  const [logs, setLogs] = useState<string[]>([]);
  const log = useCallback((val: string) => setLogs((prev) => [...prev, val]), []);

  const input = useCallback((val: string) => {
    const bytes = encoder.encode(val + '\n');
    const resolve = stdinResolveRef.current;
    if (resolve) {
      stdinResolveRef.current = null;
      resolve(bytes);
    } else {
      stdinQueueRef.current.push(bytes);
    }
    log(`> ${val}\n`);
  }, [log]);

  useEffect(() => {
    const stdinHandler: InputStreamHandler = {
      blockingRead(len: number): Promise<Uint8Array> {
        const queued = stdinQueueRef.current.shift();
        if (queued) return Promise.resolve(queued.subarray(0, len));
        return new Promise((resolve) => {
          stdinResolveRef.current = (data) => resolve(data.subarray(0, len));
        });
      },
    };

    const stdoutHandler: OutputStreamHandler = {
      write(buf: Uint8Array) {
        log(decoder.decode(buf));
      },
    };

    const stderrHandler: OutputStreamHandler = {
      write(buf: Uint8Array) {
        log(decoder.decode(buf));
      },
    };

    const loop = new IoLoop({
      onCall: createCallHandler({
        stdin: stdinHandler,
        stdout: stdoutHandler,
        stderr: stderrHandler,
      }),
    });

    const port = loop.addWorker();

    const worker = workerRef.current = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'port', port }, [port]);

    return () => {
      workerRef.current?.terminate();
      loop.dispose();
    };
  }, [log]);

  return <Console logs={logs} onInput={input} />;
}

function Console({ logs, onInput }: { logs: string[], onInput?: (val: string) => void }) {
  const handleKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const val = e.currentTarget.value;
    onInput?.(val);
    e.currentTarget.value = '';
    e.currentTarget.focus();
  }, [onInput]);

  return (
    <pre>
      {logs}
      <input
        style={{ display: 'inline-block', border: 'none', outline: 'none', width: '100%' }}
        onKeyDown={handleKey}
        autoFocus
      />
    </pre>
  );
}
