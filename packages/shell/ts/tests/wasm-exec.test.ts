import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { CommandRegistry } from '@mithic/process/component/registry';
import { createCommandResolver, type SyncInstantiateFn } from '../commands.ts';
import { createPipe } from '@mithic/process/io';

/** Write bytes to a MemoryFsProvider via open/write/close. */
function writeFile(fs: MemoryFsProvider, path: string, data: Uint8Array): void {
  const handle = fs.open(path, { create: true, write: true, truncate: true });
  try {
    fs.write(handle, data, 0);
  } finally {
    fs.close(handle);
  }
}

function createMockConfig(options?: { registry?: CommandRegistry }) {
  const memFs = new MemoryFsProvider();
  const vfs = new SyncFileSystemRouter();
  vfs.mount('/', memFs);
  const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(vfs, '/'));
  const mockInstantiate: SyncInstantiateFn = (_c, _i, _ic) => ({ run: { run: () => 0 } });

  return {
    memFs: vfs,
    rootDescriptor,
    shellInstantiate: mockInstantiate,
    shellCompileCore: () => ({} as WebAssembly.Module),
    coreutilsInstantiate: mockInstantiate,
    coreutilsCompileCore: () => ({} as WebAssembly.Module),
    createProcessImports: () => ({}),
    registry: options?.registry,
    rawFs: memFs,
  };
}

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe('WASM Execution in CommandResolver', () => {
  it('should return 126 with informative error when no registry configured', () => {
    const config = createMockConfig();
    writeFile(config.rawFs, '/app.wasm', WASM_MAGIC);
    config.rawFs.chmod('/app.wasm', 0o755);

    const resolver = createCommandResolver(config);
    const handler = resolver('/app.wasm');
    assert.ok(handler);

    const stderrPipe = createPipe();
    const stdinPipe = createPipe();
    stdinPipe.output[Symbol.dispose]();

    const code = handler([], {
      cwd: '/',
      env: {},
      stdin: stdinPipe.input,
      stdout: stderrPipe.output,
      stderr: stderrPipe.output,
    });

    assert.equal(code, 126);
    const errBytes = stderrPipe.input.read(4096n);
    if (errBytes) {
      const msg = new TextDecoder().decode(errBytes);
      assert.ok(
        msg.includes('not available') || msg.includes('no compiler'),
        `Expected informative error, got: ${msg}`,
      );
    }
  });

  it('should return 126 for non-executable WASM file', () => {
    const registry = new CommandRegistry({ precompiled: new Map() });
    const config = createMockConfig({ registry });
    // Write WASM but DON'T chmod +x
    writeFile(config.rawFs, '/app.wasm', WASM_MAGIC);

    const resolver = createCommandResolver(config);
    const handler = resolver('/app.wasm');
    assert.ok(handler);

    const stderrPipe = createPipe();
    const stdinPipe = createPipe();
    stdinPipe.output[Symbol.dispose]();

    const code = handler([], {
      cwd: '/',
      env: {},
      stdin: stdinPipe.input,
      stdout: stderrPipe.output,
      stderr: stderrPipe.output,
    });

    assert.equal(code, 126);
  });

  it('should still resolve builtins normally with registry present', () => {
    const registry = new CommandRegistry({
      precompiled: new Map([
        ['coreutils', {
          commands: new Set(['cat', 'echo', 'ls']),
          compileCore: () => ({} as WebAssembly.Module),
          instantiate: ((_c, _i, _ic) => ({ run: { run: () => 0 } })) as SyncInstantiateFn,
        }],
      ]),
    });
    const config = createMockConfig({ registry });
    const resolver = createCommandResolver(config);

    // Builtins still resolve via the normal COREUTILS_COMMANDS path
    assert.ok(resolver('cat'));
    assert.ok(resolver('ls'));
    assert.ok(resolver('sh'));
  });

  it('should handle WASM file found via PATH lookup without registry', () => {
    const config = createMockConfig();
    config.rawFs.mkdir('/usr');
    config.rawFs.mkdir('/usr/bin');
    writeFile(config.rawFs, '/usr/bin/app', WASM_MAGIC);
    config.rawFs.chmod('/usr/bin/app', 0o755);

    const resolver = createCommandResolver(config);
    const handler = resolver('app');
    assert.ok(handler);

    const stderrPipe = createPipe();
    const stdinPipe = createPipe();
    stdinPipe.output[Symbol.dispose]();

    const code = handler([], {
      cwd: '/',
      env: { PATH: '/usr/bin' },
      stdin: stdinPipe.input,
      stdout: stderrPipe.output,
      stderr: stderrPipe.output,
    });

    assert.equal(code, 126);
  });
});
