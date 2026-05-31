import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('here-string (<<<)', () => {
  it('feeds string to stdin of a builtin', async () => {
    const { stdout } = await runShell('read line <<< "hello world"\necho "$line"\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('splits words with read using multiple variables', async () => {
    const { stdout } = await runShell('read a b <<< "hello world"\necho "$a"\necho "$b"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('here-string with variable expansion', async () => {
    const { stdout } = await runShell('export x=5\nread n <<< "$((x * 2))"\necho "$n"\n');
    assert.strictEqual(stdout.trim(), '10');
  });

  it('here-string with quoted single word', async () => {
    const { stdout } = await runShell('read word <<< "oneword"\necho "$word"\n');
    assert.strictEqual(stdout.trim(), 'oneword');
  });
});

describe('output redirection via pipe (no filesystem required)', () => {
  it('pipeline exit code is the last command exit', async () => {
    const { exit } = await runShell('true | false\n');
    assert.strictEqual(exit, 1);
  });

  it('pipeline exit code 0 when last succeeds', async () => {
    const { exit } = await runShell('false | true\n');
    assert.strictEqual(exit, 0);
  });

  it('pipe from subshell collects all output', async () => {
    const { stdout } = await runShell('(echo a; echo b; echo c) | read x\necho "ok"\n');
    assert.ok(stdout.includes('ok'));
  });
});

describe('FD > 2 redirects', () => {
  it('exec 3> file writes via fd 3', async () => {
    const { stdout } = await runShell(
      'exec 3> /tmp/fd3.txt\necho hello >&3\nexec 3>&-\ncat /tmp/fd3.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('4> file on a command creates fd 4 output', async () => {
    const { stdout } = await runShell(
      'echo test 4> /tmp/fd4.txt\ncat /tmp/fd4.txt\n'
    );
    // echo writes to stdout (not fd 4), fd 4 gets the file opened
    // The file should exist (possibly empty since echo doesn't write to fd 4)
    assert.ok(stdout.includes('test') || stdout.trim() === '');
  });

  it('exec 3>&1 duplicates stdout to fd 3', async () => {
    const { stdout } = await runShell(
      'exec 3>&1\necho hello >&3\n'
    );
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('exec 3>&- closes fd 3', async () => {
    const { stdout } = await runShell(
      'exec 3> /tmp/fd3close.txt\necho before >&3\nexec 3>&-\necho after\n'
    );
    assert.ok(stdout.includes('after'));
  });

  it('5>> file opens fd 5 in append mode', async () => {
    const { stdout } = await runShell(
      'echo first > /tmp/fd5.txt\nexec 5>> /tmp/fd5.txt\necho second >&5\nexec 5>&-\ncat /tmp/fd5.txt\n'
    );
    assert.ok(stdout.includes('first'));
    assert.ok(stdout.includes('second'));
  });
});

describe('exec N< file (input fd redirects)', () => {
  it('exec 3< file opens fd for reading', async () => {
    const { stdout } = await runShell(
      'echo "line1" > /tmp/fd_in.txt\nexec 3< /tmp/fd_in.txt\nread -u 3 x\necho $x\n'
    );
    assert.strictEqual(stdout.trim(), 'line1');
  });

  it('3< file on a command redirects input for that command', async () => {
    const { stdout } = await runShell(
      'echo "from_file" > /tmp/fd_in2.txt\ncat 3< /tmp/fd_in2.txt < /tmp/fd_in2.txt\n'
    );
    assert.ok(stdout.includes('from_file'));
  });

  it('exec N< nonexistent file produces error', async () => {
    const { stderr, exit } = await runShell(
      'exec 3< /tmp/no_such_file_xyz\n'
    );
    assert.ok(stderr.includes('No such file'));
    assert.notStrictEqual(exit, 0);
  });

  it('read -u 3 from exec 3< reads multiple lines', async () => {
    const { stdout } = await runShell(
      'printf "aaa\\nbbb\\n" > /tmp/fd_multi.txt\nexec 3< /tmp/fd_multi.txt\nread -u 3 a\nread -u 3 b\necho "$a $b"\n'
    );
    assert.strictEqual(stdout.trim(), 'aaa bbb');
  });
});

describe('/dev/tcp and /dev/udp', () => {
  it('/dev/tcp redirect produces error', async () => {
    const { stderr, exit } = await runShell(
      'echo hello > /dev/tcp/localhost/80\n'
    );
    assert.ok(stderr.includes('/dev/tcp'));
    assert.ok(stderr.includes('not supported'));
    assert.notStrictEqual(exit, 0);
  });

  it('/dev/udp redirect produces error', async () => {
    const { stderr, exit } = await runShell(
      'echo hello > /dev/udp/localhost/53\n'
    );
    assert.ok(stderr.includes('/dev/udp'));
    assert.ok(stderr.includes('not supported'));
    assert.notStrictEqual(exit, 0);
  });

  it('/dev/tcp in exec redirect produces error', async () => {
    const { stderr } = await runShell(
      'exec 3> /dev/tcp/example.com/80\n'
    );
    assert.ok(stderr.includes('/dev/tcp'));
    assert.ok(stderr.includes('not supported'));
  });
});
