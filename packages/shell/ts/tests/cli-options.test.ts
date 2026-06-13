import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runCli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('sh -c (command string execution)', () => {
  it('-c executes a command string', async () => {
    const { stdout } = await runCli(['-c', 'echo hello']);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('-c returns non-zero exit code', async () => {
    const { exit } = await runCli(['-c', 'exit 1']);
    assert.strictEqual(exit, 1);
  });

  it('-c with multiple commands', async () => {
    const { stdout } = await runCli(['-c', 'echo one; echo two']);
    assert.strictEqual(stdout.trim(), 'one\ntwo');
  });

  it('-c sets positional params from remaining args', async () => {
    const { stdout } = await runCli(['-c', 'echo $1 $2', 'sh', 'hello', 'world']);
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('-c with empty string exits 0', async () => {
    const { exit } = await runCli(['-c', '']);
    assert.strictEqual(exit, 0);
  });
});

describe('shell name', () => {
  it('error messages use shell name', async () => {
    const { stderr } = await runCli(['-c', 'nonexistent_cmd_xyz']);
    assert.ok(stderr.includes('sh: nonexistent_cmd_xyz: command not found') || stderr.includes(': nonexistent_cmd_xyz: command not found'));
  });

  it('$0 is set', async () => {
    const { stdout } = await runCli(['-c', 'echo $0']);
    assert.ok(stdout.trim().length > 0);
  });
});

describe('shell option flags', () => {
  it('-e exits on first error', async () => {
    const { stdout, exit } = await runCli(['-e', '-c', 'false; echo should_not_print']);
    assert.strictEqual(stdout.trim(), '');
    assert.notStrictEqual(exit, 0);
  });

  it('-x prints trace to stderr', async () => {
    const { stderr } = await runCli(['-x', '-c', 'echo hi']);
    assert.ok(stderr.includes('+ echo hi'));
  });

  it('-u errors on unset variable', async () => {
    const { exit } = await runCli(['-u', '-c', 'echo $UNDEFINED_VAR_XYZ']);
    assert.notStrictEqual(exit, 0);
  });

  it('--version prints version', async () => {
    const { stdout, exit } = await runCli(['--version']);
    assert.ok(stdout.includes('0.1'));
    assert.strictEqual(exit, 0);
  });

  it('--help prints usage', async () => {
    const { stdout, exit } = await runCli(['--help']);
    assert.ok(stdout.includes('-c'));
    assert.strictEqual(exit, 0);
  });

  it('-v prints input lines', async () => {
    const { stderr } = await runCli(['-v', '-c', 'echo hi']);
    assert.ok(stderr.includes('echo hi'));
  });
});

describe('stdin execution (default mode)', () => {
  it('reads and executes from stdin when no -c or file', async () => {
    const { stdout } = await runCli([], 'echo from_stdin\n');
    assert.strictEqual(stdout.trim(), 'from_stdin');
  });
});
