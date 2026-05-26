import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import { SimpleProcessManager } from '@mithic/process/impl/simple';
import { JustBashShell } from './shell.ts';

describe('JustBashShell', () => {
  let router: FileSystemRouter;
  let manager: SimpleProcessManager;
  let shell: JustBashShell;

  beforeEach(async () => {
    router = new FileSystemRouter();
    const provider = new MemoryFsProvider();
    await router.mount('/', provider);

    manager = new SimpleProcessManager({
      commandResolver: (file) => {
        if (file === 'hello') {
          return async (_args, ctx) => {
            const msg = new TextEncoder().encode('hello world\n');
            ctx.stdout.write(msg);
            return 0;
          };
        }
        return undefined;
      },
    });

    shell = new JustBashShell({
      processManager: manager,
      vfsRouter: router,
      cwd: '/',
      env: { HOME: '/' },
    });
  });

  it('executes built-in shell commands (echo)', async () => {
    const result = await shell.exec('echo "hello from shell"');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'hello from shell\n');
    assert.equal(result.exitCode, 0);
  });

  it('executes built-in shell commands (pwd)', async () => {
    const result = await shell.exec('pwd');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout.trim(), '/');
    assert.equal(result.exitCode, 0);
  });

  it('spawns child process via spawn command', async () => {
    const result = await shell.exec('spawn hello');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'hello world\n');
    assert.equal(result.exitCode, 0);
  });

  it('spawn reports not-found for unknown program', async () => {
    const result = await shell.exec('spawn nonexistent');
    const stderr = new TextDecoder().decode(result.stderr);
    assert.ok(stderr.includes('command not found'));
    assert.equal(result.exitCode, 127);
  });

  it('setCwd/getCwd', () => {
    shell.setCwd('/tmp');
    assert.equal(shell.getCwd(), '/tmp');
  });

  it('setEnv/getEnv', () => {
    shell.setEnv({ FOO: 'bar' });
    const env = shell.getEnv();
    assert.equal(env.FOO, 'bar');
  });

  it('writes to VFS via shell commands', async () => {
    await shell.exec('echo "file content" > /test.txt');
    const exists = await router.exists('/test.txt');
    assert.equal(exists, true);
  });
});
