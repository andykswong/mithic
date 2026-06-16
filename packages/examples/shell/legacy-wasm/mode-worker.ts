import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import type { ProcessWorker, ProcessManager } from '@mithic/process/types';
import type { InputStreamHandler, OutputStreamHandler, SyncOutputStreamHandler } from '@mithic/io/io';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { createWorkerStrategy } from '@mithic/shell';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';
import { modules as rustComponentModules } from '@mithic/example-rust-component/component';
import shellJsSource from '@mithic/shell/component.js?raw';
import coreutilsJsSource from '@mithic/coreutils/component.js?raw';
import rustComponentJsSource from '@mithic/example-rust-component/component.js?raw';
import type { FileSystemRouter } from '@mithic/io/vfs';

interface Stdio {
  stdin: InputStreamHandler;
  stdout: OutputStreamHandler & SyncOutputStreamHandler;
  stderr: OutputStreamHandler & SyncOutputStreamHandler;
}

async function fetchModuleBytes(dataUris: Record<string, string>): Promise<Record<string, Uint8Array>> {
  const modules: Record<string, Uint8Array> = {};
  await Promise.all(
    Object.entries(dataUris).map(async ([name, uri]) => {
      const response = await fetch(uri);
      modules[name] = new Uint8Array(await response.arrayBuffer());
    }),
  );
  return modules;
}

export async function createWorkerManager(vfs: FileSystemRouter, stdio: Stdio): Promise<ProcessManager & Disposable> {
  const [shellRawModules, coreutilsRawModules, rustComponentRawModules] = await Promise.all([
    fetchModuleBytes(shellModules),
    fetchModuleBytes(coreutilsModules),
    fetchModuleBytes(rustComponentModules),
  ]);

  const shellCompileResult: CompileResult = {
    modules: shellRawModules,
    jsFiles: { 'component.js': shellJsSource },
    cached: true,
  };
  const coreutilsCompileResult: CompileResult = {
    modules: coreutilsRawModules,
    jsFiles: { 'component.js': coreutilsJsSource },
    cached: true,
  };
  const rustComponentCompileResult: CompileResult = {
    modules: rustComponentRawModules,
    jsFiles: { 'component.js': rustComponentJsSource },
    cached: true,
  };

  function createWebWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }

  function createWorker(file: string): ProcessWorker | undefined {
    const cmdName = file.includes('/') ? file.split('/').pop()! : file;
    if (cmdName === 'sh' || cmdName === 'bash') {
      return new ComponentProcessWorker(createWebWorker(), shellCompileResult);
    }
    if (COREUTILS_COMMANDS.has(cmdName)) {
      return new ComponentProcessWorker(createWebWorker(), coreutilsCompileResult);
    }
    if (cmdName === 'rust-component') {
      return new ComponentProcessWorker(createWebWorker(), rustComponentCompileResult);
    }
    return undefined;
  }

  return createWorkerStrategy({
    fs: vfs,
    stdio,
    isatty: { stdin: true, stdout: true, stderr: true },
    createWorker,
  });
}
