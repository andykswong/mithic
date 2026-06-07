/**
 * End-to-end integration tests: io → wasip2 → process → shell → coreutils
 *
 * Each test exercises the full stack: MemoryFsProvider (io) is mounted into the
 * VFS, the WASIShim (wasip2) exposes it to the WASM shell component, the
 * WASIProcess / SimpleProcessManager (process) handles spawning sub-commands,
 * and the Rust shell (shell) interprets the script and forks coreutils processes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
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
// Multi-command pipelines (shell → process → coreutils)
// =============================================================================

describe('e2e: multi-command pipelines', () => {
  it('echo | tr: character translation in a two-stage pipeline', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | tr "a-z" "A-Z"\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'HELLO WORLD');
  });

  it('echo | sort | head: three-stage pipeline selects first sorted word', async () => {
    // "hello world" split to one-word-per-line, sorted, first line = "hello"
    const { stdout, exit } = await runShell('printf "world\\nhello\\n" | sort | head -n 1\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('seq | grep | wc: four-stage pipeline counts filtered lines', async () => {
    // seq 1 10 → grep lines containing "1" (1, 10) → wc -l = 2
    const { stdout, exit } = await runShell('seq 1 10 | grep "1" | wc -l\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2');
  });

  it('echo | tr | sort | uniq: deduplication pipeline', async () => {
    const { stdout, exit } = await runShell(
      'printf "banana\\napple\\nbanana\\ncherry\\napple\\n" | sort | uniq\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'apple\nbanana\ncherry');
  });

  it('seq | tail: last N lines of generated sequence', async () => {
    const { stdout, exit } = await runShell('seq 1 5 | tail -n 2\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4\n5');
  });
});

// =============================================================================
// VFS file operations (io layer) through the shell
// =============================================================================

describe('e2e: VFS file operations', () => {
  it('write to VFS and read back via cat', async () => {
    const { stdout, exit } = await runShell(
      'echo "e2e content" > /tmp/e2e_read.txt\ncat /tmp/e2e_read.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'e2e content');
  });

  it('write then count bytes with wc -c', async () => {
    // "test data\n" = 10 bytes
    const { stdout, exit } = await runShell(
      'printf "test data\\n" > /tmp/e2e_wc.txt\nwc -c /tmp/e2e_wc.txt\n'
    );
    assert.strictEqual(exit, 0);
    const count = parseInt(stdout.trim());
    assert.ok(count > 0, `expected byte count > 0, got ${count}`);
  });

  it('pipeline output redirected to VFS file, read back and transformed', async () => {
    const { stdout, exit } = await runShell(
      'seq 1 3 > /tmp/e2e_seq.txt\ncat /tmp/e2e_seq.txt | sort -r\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3\n2\n1');
  });

  it('tee duplicates pipeline output to VFS file', async () => {
    const { stdout, exit } = await runShell(
      'echo "tee test" | tee /tmp/e2e_tee.txt\ncat /tmp/e2e_tee.txt\n'
    );
    assert.strictEqual(exit, 0);
    // tee emits to stdout and also writes to file; cat reads it back
    assert.ok(stdout.includes('tee test'));
  });

  it('cp and mv work across VFS paths', async () => {
    const { stdout, exit } = await runShell(
      'echo "original" > /tmp/e2e_src.txt\n' +
      'cp /tmp/e2e_src.txt /tmp/e2e_dst.txt\n' +
      'cat /tmp/e2e_dst.txt\n' +
      'mv /tmp/e2e_dst.txt /tmp/e2e_moved.txt\n' +
      'cat /tmp/e2e_moved.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'original\noriginal');
  });
});

// =============================================================================
// Command substitution (shell → process → coreutils → shell)
// =============================================================================

describe('e2e: command substitution', () => {
  it('$(wc -w) result embedded in echo', async () => {
    const { stdout, exit } = await runShell('count=$(echo "a b c" | wc -w)\necho "count: $count"\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('count:'), `expected "count:" in: ${stdout}`);
    assert.ok(stdout.includes('3'), `expected word count 3 in: ${stdout}`);
  });

  it('$(seq) used in arithmetic', async () => {
    const { stdout, exit } = await runShell('last=$(seq 1 5 | tail -n 1)\necho $((last * 2))\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10');
  });

  it('nested command substitution through pipeline', async () => {
    const { stdout, exit } = await runShell(
      'result=$(printf "z\\na\\nm\\n" | sort | head -n 1)\necho "$result"\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a');
  });
});

// =============================================================================
// Environment variables through process spawning
// =============================================================================

describe('e2e: environment variable propagation', () => {
  it('exported variable visible in piped command context', async () => {
    const { stdout, exit } = await runShell('export E2E_VAR=hello\necho $E2E_VAR | cat\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('variable set before pipeline is accessible in command substitution', async () => {
    const { stdout, exit } = await runShell(
      'export PREFIX=item\nresult=$(echo "${PREFIX}_value")\necho "$result"\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'item_value');
  });
});

// =============================================================================
// Exit code propagation
// =============================================================================

describe('e2e: exit code propagation', () => {
  it('pipeline exit code reflects last command success', async () => {
    const { exit } = await runShell('echo hello | cat\n');
    assert.strictEqual(exit, 0);
  });

  it('pipeline exit code reflects last command failure', async () => {
    const { exit } = await runShell('echo hello | grep "no_match_xyz"\n');
    assert.strictEqual(exit, 1);
  });

  it('false | true exit code is 0 (last command wins)', async () => {
    const { exit } = await runShell('false | true\n');
    assert.strictEqual(exit, 0);
  });

  it('coreutils command not found exits non-zero', async () => {
    const { exit } = await runShell('__no_such_e2e_cmd_xyz\n');
    assert.notStrictEqual(exit, 0);
  });

  it('&& chains succeed: write then read from VFS', async () => {
    const { stdout, exit } = await runShell(
      'echo "chain" > /tmp/e2e_chain.txt && cat /tmp/e2e_chain.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'chain');
  });

  it('|| fallback runs when first command fails', async () => {
    const { stdout, exit } = await runShell(
      'grep "no_match" /tmp/e2e_chain.txt 2>/dev/null || echo "fallback"\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'fallback');
  });
});

// =============================================================================
// sh -c sub-shell (full process spawn round-trip)
// =============================================================================

describe('e2e: sub-shell via sh -c', () => {
  it('sh -c executes a pipeline', async () => {
    const { stdout, exit } = await runShell('sh -c "printf \\"x\\ny\\nz\\n\\" | sort -r"\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'z\ny\nx');
  });

  it('sh -c result captured via command substitution', async () => {
    const { stdout, exit } = await runShell('r=$(sh -c "seq 1 3 | wc -l")\necho "lines=$r"\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('lines='), `expected "lines=" in: ${stdout}`);
    assert.ok(stdout.includes('3'), `expected 3 in: ${stdout}`);
  });
});

// =============================================================================
// sed (hold-space / branching) through full stack
// =============================================================================

describe('e2e: sed through the full stack', () => {
  it('sed substitution in pipeline', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | sed "s/world/shell/"\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello shell');
  });

  it('sed with hold-space via pipeline', async () => {
    // Save line 1 in hold space, retrieve it on line 2 using -e expressions
    // (brace-group syntax is not supported; use separate -e flags instead)
    const { stdout, exit } = await runShell(
      'printf "first\\nsecond\\n" | sed -n -e "1h" -e "2G" -e "2p"\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'second\nfirst');
  });
});

// =============================================================================
// find command integration
// =============================================================================

describe('e2e: find through the full stack', () => {
  it('find locates files created via VFS write', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp/e2e_find\n' +
      'touch /tmp/e2e_find/alpha.txt\n' +
      'touch /tmp/e2e_find/beta.txt\n' +
      'find /tmp/e2e_find -name "*.txt" | sort\n'
    );
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('alpha.txt'), `expected alpha.txt in: ${stdout}`);
    assert.ok(stdout.includes('beta.txt'), `expected beta.txt in: ${stdout}`);
  });

  it('find piped to wc -l counts files', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp/e2e_findwc\n' +
      'touch /tmp/e2e_findwc/a.log\n' +
      'touch /tmp/e2e_findwc/b.log\n' +
      'touch /tmp/e2e_findwc/c.log\n' +
      'find /tmp/e2e_findwc -name "*.log" | wc -l\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3');
  });
});
