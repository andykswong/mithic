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
            ctx.stdout.write(new TextEncoder().encode('hello world\n'));
            return 0;
          };
        }
        if (file === 'cat-stdin') {
          return async (_args, ctx) => {
            try {
              while (true) {
                const chunk = ctx.stdin.blockingRead(65536n);
                ctx.stdout.write(chunk);
              }
            } catch (e: unknown) {
              if (typeof e === 'object' && e !== null && 'tag' in e && (e as { tag: string }).tag === 'closed') {
                return 0;
              }
              throw e;
            }
          };
        }
        if (file === 'fail-cmd') {
          return async () => 42;
        }
        if (file === 'err-cmd') {
          return async (_args, ctx) => {
            ctx.stderr.write(new TextEncoder().encode('something went wrong\n'));
            return 1;
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

  it('spawns child process via run command', async () => {
    const result = await shell.exec('run hello');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'hello world\n');
    assert.equal(result.exitCode, 0);
  });

  it('spawns child process via exec-fallback (transparent)', async () => {
    const result = await shell.exec('hello');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'hello world\n');
    assert.equal(result.exitCode, 0);
  });

  it('pipes stdin to child process via run', async () => {
    const result = await shell.exec('echo "piped input" | run cat-stdin');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'piped input\n');
    assert.equal(result.exitCode, 0);
  });

  it('pipes stdin to child process via exec-fallback', async () => {
    const result = await shell.exec('echo "piped" | cat-stdin');
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(stdout, 'piped\n');
    assert.equal(result.exitCode, 0);
  });

  it('propagates non-zero exit code from child process', async () => {
    const result = await shell.exec('fail-cmd');
    assert.equal(result.exitCode, 42);
  });

  it('captures stderr from child process', async () => {
    const result = await shell.exec('err-cmd');
    const stderr = new TextDecoder().decode(result.stderr);
    assert.equal(stderr, 'something went wrong\n');
    assert.equal(result.exitCode, 1);
  });

  it('run reports not-found for unknown program', async () => {
    const result = await shell.exec('run nonexistent');
    const stderr = new TextDecoder().decode(result.stderr);
    assert.ok(stderr.includes('command not found'));
    assert.equal(result.exitCode, 1);
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
