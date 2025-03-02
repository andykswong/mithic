'use client';

import { IoStreamReactor, WebReadStream, WebWriteStream } from '@mithic/core';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { stdin, stdout } from '../stdio.ts';

export default function Page() {
  const reactorRef = useRef<IoStreamReactor | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);

  const [logs, setLogs] = useState<string[]>([]);
  const [onInput, setOnInput] = useState<(val: string) => void>(() => () => undefined);
  const log = useCallback((val: string) => setLogs((logs) => [...logs, `${val}\n`]), [setLogs]);
  const input = useCallback((val: string) => {
    onInput(val);
    log(`> ${val}`);
  }, [log, onInput]);

  useEffect(() => {
    const reactor = reactorRef.current = new IoStreamReactor({
      read(identifier) {
        if (identifier === '/dev/stdin') {
          return [0, new WebReadStream(stdin((onInput) => setOnInput(() => onInput)))];
        }
      },
      write(identifier) {
        if (identifier === '/dev/stdout') {
          return [1, new WebWriteStream(stdout(log))];
        } else if (identifier === '/dev/stderr') {
          return [2, new WebWriteStream(stdout(log))];
        }
      },
    });

    const worker = workerRef.current = new Worker(new URL('../worker.ts', import.meta.url));
    worker.postMessage(reactor.addChannel());

    return () => workerRef.current?.terminate();
  }, [log, setOnInput]);

  return (
    <StrictMode>
      <Console logs={logs} onInput={input} />
    </StrictMode>
  );
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
