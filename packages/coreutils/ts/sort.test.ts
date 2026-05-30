import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../../shell/ts/cli.ts');

function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
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

// =============================================================================
// sort
// =============================================================================

describe('sort', () => {
  it('alphabetical sort by default', async () => {
    const { stdout } = await runShell('printf "banana\\napple\\ncherry\\n" | sort\n');
    assert.strictEqual(stdout.trim(), 'apple\nbanana\ncherry');
  });

  it('-r reverses sort order', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sort -r\n');
    assert.strictEqual(stdout.trim(), 'c\nb\na');
  });

  it('-n numeric sort', async () => {
    const { stdout } = await runShell('printf "10\\n2\\n1\\n" | sort -n\n');
    assert.strictEqual(stdout.trim(), '1\n2\n10');
  });

  it('-n -r numeric reverse sort', async () => {
    const { stdout } = await runShell('printf "1\\n10\\n2\\n" | sort -n -r\n');
    assert.strictEqual(stdout.trim(), '10\n2\n1');
  });

  it('-u removes duplicate lines', async () => {
    const { stdout } = await runShell('printf "b\\na\\nb\\na\\nc\\n" | sort -u\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('-u deduplicates across all input', async () => {
    const { stdout } = await runShell('printf "b\\na\\nb\\na\\n" | sort -u\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('-u with -k deduplicates by key field', async () => {
    const { stdout } = await runShell('printf "a 1\\nb 2\\na 3\\n" | sort -k1,1 -u\n');
    assert.strictEqual(stdout.trim(), 'a 1\nb 2');
  });

  it('sorts file input', async () => {
    const { stdout } = await runShell(
      'printf "z\\na\\nm\\n" > /tmp/sort_in.txt\nsort /tmp/sort_in.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nm\nz');
  });

  it('stable on equal elements', async () => {
    const { stdout } = await runShell('printf "b\\na\\nc\\n" | sort\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('-k key field sort', async () => {
    const { stdout } = await runShell('printf "b 2\\na 1\\nc 3\\n" | sort -k2,2n\n');
    assert.strictEqual(stdout.trim(), 'a 1\nb 2\nc 3');
  });

  it('-t custom delimiter with -k', async () => {
    const { stdout } = await runShell('printf "x:3\\ny:1\\nz:2\\n" | sort -t: -k2,2n\n');
    assert.strictEqual(stdout.trim(), 'y:1\nz:2\nx:3');
  });
});

// =============================================================================
// uniq
// =============================================================================

describe('uniq', () => {
  it('removes adjacent duplicates', async () => {
    const { stdout } = await runShell('printf "a\\na\\nb\\nb\\na\\n" | uniq\n');
    assert.strictEqual(stdout.trim(), 'a\nb\na');
  });

  it('passes through already-unique lines unchanged', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | uniq\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('works on file input', async () => {
    const { stdout } = await runShell(
      'printf "x\\nx\\ny\\n" > /tmp/uniq_in.txt\nuniq /tmp/uniq_in.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'x\ny');
  });

  it('-c prefixes count', async () => {
    const { stdout } = await runShell('printf "a\\na\\nb\\n" | uniq -c\n');
    assert.ok(stdout.includes('2'));
    assert.ok(stdout.includes('1'));
  });

  it('-d shows only duplicate lines', async () => {
    const { stdout } = await runShell('printf "a\\na\\nb\\nb\\nc\\n" | uniq -d\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('-u shows only unique lines', async () => {
    const { stdout } = await runShell('printf "a\\na\\nb\\nb\\nc\\n" | uniq -u\n');
    assert.strictEqual(stdout.trim(), 'c');
  });

  it('-i case-insensitive dedup', async () => {
    const { stdout } = await runShell('printf "Apple\\napple\\nBanana\\n" | uniq -i\n');
    assert.strictEqual(stdout.trim(), 'Apple\nBanana');
  });
});

// =============================================================================
// seq
// =============================================================================

describe('seq', () => {
  it('generates a simple range', async () => {
    const { stdout } = await runShell('seq 1 5\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3\n4\n5');
  });

  it('generates a range with custom step', async () => {
    const { stdout } = await runShell('seq 1 2 7\n');
    assert.strictEqual(stdout.trim(), '1\n3\n5\n7');
  });

  it('single argument counts from 1', async () => {
    const { stdout } = await runShell('seq 3\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });

  it('generates descending range with negative step', async () => {
    const { stdout } = await runShell('seq 5 -1 1\n');
    assert.strictEqual(stdout.trim(), '5\n4\n3\n2\n1');
  });

  it('empty range when start > end with positive step', async () => {
    const { stdout } = await runShell('seq 5 1\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('works in pipeline with wc', async () => {
    const { stdout } = await runShell('seq 1 10 | wc -l\n');
    assert.strictEqual(stdout.trim(), '10');
  });

  it('-f format string', async () => {
    const { stdout } = await runShell('seq -f "%03g" 1 3\n');
    assert.strictEqual(stdout.trim(), '001\n002\n003');
  });

  it('-s separator', async () => {
    const { stdout } = await runShell('seq -s, 1 3\n');
    assert.strictEqual(stdout.trim(), '1,2,3');
  });
});
