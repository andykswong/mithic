import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

async function runShell(script: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

async function runShellArgs(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI, ...args], {
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
    child.stdin.end();
  });
}

describe('startup file sourcing', () => {
  describe('~/.bashrc (interactive bash mode)', () => {
    it('~/.bashrc not sourced in non-interactive mode (piped stdin)', async () => {
      const { stdout } = await runShell(
        'echo "export BASHRC_LOADED=yes" > /root/.bashrc\necho ${BASHRC_LOADED:-no}\n'
      );
      assert.strictEqual(stdout.trim(), 'no');
    });

    it('~/.bashrc sourced via BASH_ENV workaround for non-interactive', async () => {
      const { stdout } = await runShell(
        'echo "export FROM_RC=loaded" > /root/.bashrc\nexport BASH_ENV=/root/.bashrc\nbash -c \'echo $FROM_RC\'\n'
      );
      assert.strictEqual(stdout.trim(), 'loaded');
    });

    it('~/.bashrc not sourced when file does not exist', async () => {
      const { stdout, exit } = await runShell('echo ${BASHRC_LOADED:-none}\n');
      assert.strictEqual(stdout.trim(), 'none');
      assert.strictEqual(exit, 0);
    });
  });

  describe('$BASH_ENV (non-interactive bash mode)', () => {
    it('$BASH_ENV file sourced in non-interactive mode', async () => {
      const { stdout } = await runShell(
        'echo "export INIT_VAR=from_bash_env" > /tmp/myenv.sh\nexport BASH_ENV=/tmp/myenv.sh\nbash -c \'echo $INIT_VAR\'\n'
      );
      assert.strictEqual(stdout.trim(), 'from_bash_env');
    });

    it('$BASH_ENV not sourced when empty', async () => {
      const { stdout } = await runShellArgs(
        ['-c', 'echo ${BASH_ENV_LOADED:-no}'],
        { BASH_ENV: '' },
      );
      assert.strictEqual(stdout.trim(), 'no');
    });
  });

  describe('$ENV (POSIX mode)', () => {
    it('$ENV file sourced in POSIX interactive subshell', async () => {
      const { stdout } = await runShell(
        'echo "export POSIX_INIT=loaded" > /tmp/posix_env.sh\nexport ENV=/tmp/posix_env.sh\nsh -c \'echo $POSIX_INIT\'\n'
      );
      assert.strictEqual(stdout.trim(), 'loaded');
    });

    it('$ENV file sourced in POSIX non-interactive mode', async () => {
      const { stdout } = await runShell(
        'echo "export POSIX_NI=yes" > /tmp/posix_ni.sh\nexport ENV=/tmp/posix_ni.sh\nsh -c \'echo $POSIX_NI\'\n'
      );
      assert.strictEqual(stdout.trim(), 'yes');
    });
  });

  describe('no hardcoded greeting', () => {
    it('interactive shell does not print mithic shell v0.1.0', async () => {
      const { stdout } = await runShell('exit\n');
      assert.ok(!stdout.includes('mithic shell v0.1.0'), `unexpected greeting in: ${stdout}`);
    });
  });
});
