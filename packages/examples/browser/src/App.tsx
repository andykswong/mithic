import { useCallback, useEffect, useRef, useState } from 'react';

const encoder = new TextEncoder();

export function App() {
  const workerRef = useRef<Worker | undefined>(undefined);
  const stdinSignalRef = useRef<Int32Array | null>(null);
  const stdinDataRef = useRef<Uint8Array | null>(null);

  const [logs, setLogs] = useState<string[]>([]);
  const log = useCallback((val: string) => setLogs((logs) => [...logs, `${val}`]), [setLogs]);
  const input = useCallback((val: string) => {
    const signal = stdinSignalRef.current;
    const data = stdinDataRef.current;
    if (!signal || !data) return;

    // Write input bytes into the shared data buffer
    const bytes = encoder.encode(val + '\n');
    const writeLen = Math.min(bytes.byteLength, data.byteLength);
    data.set(bytes.subarray(0, writeLen));

    // Signal the worker: data length, then ready flag
    Atomics.store(signal, 1, writeLen);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);

    log(`> ${val}\n`);
  }, [log]);

  useEffect(() => {
    const worker = workerRef.current = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'stdout' || e.data?.type === 'stderr') {
        log(e.data.value);
      } else if (e.data?.type === 'stdin-init') {
        // Worker sent us the shared buffers for stdin communication
        stdinSignalRef.current = new Int32Array(e.data.signal);
        stdinDataRef.current = new Uint8Array(e.data.data);
      }
    };

    return () => workerRef.current?.terminate();
  }, [log]);

  return <Console logs={logs} onInput={input} />;
}

function Console({ logs, onInput }: { logs: string[], onInput?: (val: string) => void }) {
  const handleKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') { return; }
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
