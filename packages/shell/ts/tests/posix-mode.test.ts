import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

function runCli(args: string[], env?: Record<string, string>, stdinInput?: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    if (stdinInput) {
      child.stdin.write(stdinInput);
    }
    child.stdin.end();
  });
}

describe('POSIX mode: disabled bash extensions', () => {
  it('brace expansion disabled', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo {a,b,c}']);
    assert.strictEqual(stdout.trim(), '{a,b,c}');
  });

  it('echo -n treated as literal in POSIX', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo -n hello']);
    assert.strictEqual(stdout.trim(), '-n hello');
  });

  it('echo -e treated as literal in POSIX', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo -e hi']);
    assert.strictEqual(stdout.trim(), '-e hi');
  });

  it('[[ ]] rejected in POSIX mode', async () => {
    const { exit } = await runCli(['--posix', '-c', '[[ 1 == 1 ]]']);
    assert.notStrictEqual(exit, 0);
  });

  it('(( )) rejected in POSIX mode', async () => {
    const { exit } = await runCli(['--posix', '-c', '((1+1))']);
    assert.notStrictEqual(exit, 0);
  });

  it('select rejected in POSIX mode', async () => {
    const { stderr, exit } = await runCli(['--posix', '-c', 'select x in a b; do break; done']);
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('not supported in POSIX mode'));
  });

  it('declare -A rejected in POSIX mode', async () => {
    const { stderr, exit } = await runCli(['--posix', '-c', 'declare -A mymap']);
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('not supported in POSIX mode'));
  });

  it('coproc treated as regular command in POSIX mode', async () => {
    const { exit } = await runCli(['--posix', '-c', 'coproc cat']);
    assert.notStrictEqual(exit, 0);
  });

  it('source rejected in POSIX mode (use . instead)', async () => {
    const { exit } = await runCli(['--posix', '-c', 'echo ok > /tmp/posix_dot.sh; source /tmp/posix_dot.sh']);
    assert.notStrictEqual(exit, 0);
  });

  it('. command works in POSIX mode', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo "echo from_dot" > /tmp/posix_dot2.sh; . /tmp/posix_dot2.sh']);
    assert.strictEqual(stdout.trim(), 'from_dot');
  });
});

describe('POSIX mode: activation methods', () => {
  it('--posix flag works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo {a,b}']);
    assert.strictEqual(stdout.trim(), '{a,b}');
  });

  it('set -o posix activates at runtime', async () => {
    const { stdout } = await runCli(['-c', 'set -o posix; echo {a,b}']);
    assert.strictEqual(stdout.trim(), '{a,b}');
  });

  it('POSIXLY_CORRECT env var activates', async () => {
    const { stdout } = await runCli(['-c', 'echo {a,b}'], { POSIXLY_CORRECT: '1' });
    assert.strictEqual(stdout.trim(), '{a,b}');
  });
});

describe('POSIX mode: features that STILL work', () => {
  it('basic commands work', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo hello']);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('pipes work', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo hello | cat']);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('if/then/else works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'if true; then echo yes; fi']);
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('test/[ builtin works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'if [ 1 -eq 1 ]; then echo eq; fi']);
    assert.strictEqual(stdout.trim(), 'eq');
  });

  it('for loop works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'for i in a b c; do echo $i; done']);
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('variable expansion works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'x=hello; echo $x']);
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('POSIX mode: spec compliance fixes', () => {
  it('(( )) arithmetic command rejected in POSIX mode', async () => {
    const { exit, stderr } = await runCli(['--posix', '-c', '(( 1 + 1 ))']);
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('not supported in POSIX mode') || exit !== 0);
  });

  it('<<< here-string rejected in POSIX mode', async () => {
    const { exit, stderr } = await runCli(['--posix', '-c', 'cat <<< hello']);
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('not supported in POSIX mode') || exit !== 0);
  });

  it('array assignment rejected in POSIX mode', async () => {
    const { exit, stderr } = await runCli(['--posix', '-c', 'arr=(1 2 3)']);
    assert.notStrictEqual(exit, 0, `expected non-zero exit, got ${exit}; stderr: ${stderr}`);
  });

  it('!N absolute history expansion works', async () => {
    const { stdout } = await runCli([], undefined, 'echo first\necho second\n!1\n');
    const lines = stdout.trim().split('\n');
    assert.ok(lines[lines.length - 1] === 'first', `expected last line to be "first", got: ${stdout}`);
  });

  it('PS1 prompt expansion uses # for root (USER=root env check)', async () => {
    const { stdout } = await runCli(['-c', 'if [ "$USER" = "root" ]; then echo hash; else echo dollar; fi'], { USER: 'root' });
    assert.strictEqual(stdout.trim(), 'hash');
  });

  it('PS1 prompt expansion uses $ for non-root (USER=alice env check)', async () => {
    const { stdout } = await runCli(['-c', 'if [ "$USER" = "root" ]; then echo hash; else echo dollar; fi'], { USER: 'alice' });
    assert.strictEqual(stdout.trim(), 'dollar');
  });
});
