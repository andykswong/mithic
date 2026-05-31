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

describe('builtin: exec', () => {
  it('exec with redirect changes shell stdout', async () => {
    const { stdout } = await runShell('exec > /tmp/exec_out.txt\necho hello\nexec > /dev/stdout\necho "$(< /tmp/exec_out.txt)"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('builtin: readonly', () => {
  it('readonly prevents reassignment', async () => {
    const { stderr, exit } = await runShell('readonly x=10\nx=20\n');
    assert.ok(stderr.includes('readonly'));
    assert.notStrictEqual(exit, 0);
  });

  it('readonly var retains value', async () => {
    const { stdout } = await runShell('readonly x=hello\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('builtin: let', () => {
  it('let evaluates arithmetic', async () => {
    const { stdout } = await runShell('let x=5+3\necho $x\n');
    assert.strictEqual(stdout.trim(), '8');
  });

  it('let returns 1 for zero result', async () => {
    const { exit } = await runShell('let "0"\n');
    assert.strictEqual(exit, 1);
  });
});

describe('builtin: getopts', () => {
  it('getopts parses flags', async () => {
    const { stdout } = await runShell('f() { while getopts "ab:c" opt; do echo "$opt=$OPTARG"; done; }; f -a -b val -c\n');
    assert.strictEqual(stdout.trim(), 'a=\nb=val\nc=');
  });
});

describe('builtin: mapfile/readarray', () => {
  it('mapfile reads lines into array', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" > /tmp/mf.txt\nmapfile -t lines < /tmp/mf.txt\necho ${#lines[@]}\necho ${lines[1]}\n');
    assert.strictEqual(stdout.trim(), '3\nb');
  });
});

describe('builtin: hash', () => {
  it('hash with no args prints empty table', async () => {
    const { exit } = await runShell('hash\n');
    assert.strictEqual(exit, 0);
  });

  it('hash -r clears without error', async () => {
    const { exit } = await runShell('hash -r\n');
    assert.strictEqual(exit, 0);
  });

  it('hash caches command path for future lookups', async () => {
    const { stdout, exit } = await runShell('mkdir -p /usr/bin && touch /usr/bin/mycmd; hash mycmd; hash\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('mycmd=/usr/bin/mycmd'));
  });

  it('hash -r clears cached paths', async () => {
    const { stdout, exit } = await runShell('mkdir -p /usr/bin && touch /usr/bin/mycmd; hash mycmd; hash -r; hash\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('hash reports not found for missing command', async () => {
    const { exit, stderr } = await runShell('hash nonexistent_cmd\n');
    assert.strictEqual(exit, 1);
    assert.ok(stderr.includes('not found'));
  });
});

describe('builtin: fg error handling', () => {
  it('fg %99 outputs error for nonexistent job', async () => {
    const { stderr, exit } = await runShell('fg %99\n');
    assert.ok(stderr.includes('no such job'));
    assert.strictEqual(exit, 1);
  });
});

describe('prefix assignment: VAR=val cmd', () => {
  it('prefix assignment passes env to command', async () => {
    const { stdout } = await runShell('f() { echo $MY_VAR; }; MY_VAR=hello f\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('prefix assignment does not persist after command', async () => {
    const { stdout } = await runShell('f() { echo $MY_VAR; }; MY_VAR=hello f\necho "${MY_VAR:-unset}"\n');
    assert.strictEqual(stdout.trim(), 'hello\nunset');
  });

  it('multiple prefix assignments', async () => {
    const { stdout } = await runShell('f() { echo "$A $B"; }; A=1 B=2 f\n');
    assert.strictEqual(stdout.trim(), '1 2');
  });
});

describe('export without value', () => {
  it('export VAR marks existing var for export', async () => {
    const { stdout } = await runShell('x=hello\nexport x\nenv | grep "^x="\n');
    assert.strictEqual(stdout.trim(), 'x=hello');
  });

  it('export VAR=val and export VAR both work', async () => {
    const { stdout } = await runShell('export y=world\nenv | grep "^y="\n');
    assert.strictEqual(stdout.trim(), 'y=world');
  });
});
