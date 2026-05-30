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
// basename
// =============================================================================

describe('basename', () => {
  it('strips directory from path', async () => {
    const { stdout } = await runShell('basename /usr/local/bin/foo\n');
    assert.strictEqual(stdout.trim(), 'foo');
  });

  it('strips suffix when given', async () => {
    const { stdout } = await runShell('basename /path/to/file.txt .txt\n');
    assert.strictEqual(stdout.trim(), 'file');
  });

  it('handles path with no directory', async () => {
    const { stdout } = await runShell('basename file.txt\n');
    assert.strictEqual(stdout.trim(), 'file.txt');
  });

  it('handles trailing slash', async () => {
    const { stdout } = await runShell('basename /usr/local/\n');
    assert.strictEqual(stdout.trim(), 'local');
  });

  it('suffix not stripped when it does not match', async () => {
    const { stdout } = await runShell('basename /path/to/file.txt .sh\n');
    assert.strictEqual(stdout.trim(), 'file.txt');
  });
});

// =============================================================================
// dirname
// =============================================================================

describe('dirname', () => {
  it('extracts directory from path', async () => {
    const { stdout } = await runShell('dirname /usr/local/bin/foo\n');
    assert.strictEqual(stdout.trim(), '/usr/local/bin');
  });

  it('returns . for bare filename', async () => {
    const { stdout } = await runShell('dirname file.txt\n');
    assert.strictEqual(stdout.trim(), '.');
  });

  it('returns / for root path', async () => {
    const { stdout } = await runShell('dirname /foo\n');
    assert.strictEqual(stdout.trim(), '/');
  });

  it('handles trailing slash', async () => {
    const { stdout } = await runShell('dirname /usr/local/\n');
    assert.strictEqual(stdout.trim(), '/usr');
  });
});

// =============================================================================
// sed
// =============================================================================

describe('sed', () => {
  it('basic substitution s/old/new/', async () => {
    const { stdout } = await runShell('echo "hello world" | sed "s/hello/goodbye/"\n');
    assert.strictEqual(stdout.trim(), 'goodbye world');
  });

  it('global substitution s/old/new/g', async () => {
    const { stdout } = await runShell('echo "aaa" | sed "s/a/b/g"\n');
    assert.strictEqual(stdout.trim(), 'bbb');
  });

  it('substitutes first occurrence only without g flag', async () => {
    const { stdout } = await runShell('echo "aaa" | sed "s/a/b/"\n');
    assert.strictEqual(stdout.trim(), 'baa');
  });

  it('works on file input', async () => {
    const { stdout } = await runShell(
      'echo "foo bar" > /tmp/sed_in.txt\nsed "s/foo/baz/" /tmp/sed_in.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'baz bar');
  });

  it('empty replacement removes pattern text', async () => {
    const { stdout } = await runShell('echo "hello world" | sed "s/world//"\n');
    // Trailing space may or may not be trimmed by implementation
    assert.ok(stdout.includes('hello'));
    assert.ok(!stdout.includes('world'));
  });

  it('regex patterns in substitution', async () => {
    const { stdout } = await runShell('echo "abc123" | sed "s/[0-9]//g"\n');
    assert.strictEqual(stdout.trim(), 'abc');
  });

  it('line addressing: 2s substitutes only line 2', async () => {
    const { stdout } = await runShell('printf "foo\\nbar\\nbaz\\n" | sed "2s/bar/BAR/"\n');
    assert.strictEqual(stdout.trim(), 'foo\nBAR\nbaz');
  });

  it('delete command d', async () => {
    const { stdout } = await runShell('printf "keep\\ndelete me\\nkeep\\n" | sed "/delete/d"\n');
    assert.strictEqual(stdout.trim(), 'keep\nkeep');
  });

  it('print command p with -n', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sed -n "2p"\n');
    assert.strictEqual(stdout.trim(), 'b');
  });

  it('multiple -e expressions applied in sequence', async () => {
    const { stdout } = await runShell('printf "hello world\\n" | sed -e "s/hello/hi/" -e "s/world/earth/"\n');
    assert.strictEqual(stdout.trim(), 'hi earth');
  });

  it('greedy .* replaces entire line', async () => {
    const { stdout } = await runShell('printf "foo\\n" | sed "s/.*/X/"\n');
    assert.strictEqual(stdout.trim(), 'X');
  });

  it('& in replacement inserts matched text', async () => {
    const { stdout } = await runShell('printf "hello\\n" | sed "s/ell/[&]/"\n');
    assert.strictEqual(stdout.trim(), 'h[ell]o');
  });

  it('range address 1,2d deletes first two lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sed "1,2d"\n');
    assert.strictEqual(stdout.trim(), 'c');
  });
});

describe('sed hold space and branching', () => {
  it('h and g: copy to hold and get back', async () => {
    const { stdout } = await runShell('printf "first\\nsecond\\n" | sed -n -e "1h" -e "2g" -e "2p"\n');
    assert.strictEqual(stdout.trim(), 'first');
  });

  it('H and G: append to/from hold', async () => {
    const { stdout } = await runShell('printf "a\\nb\\n" | sed -n -e "H" -e "2g" -e "2p"\n');
    assert.ok(stdout.includes('a'));
    assert.ok(stdout.includes('b'));
  });

  it('x: exchange pattern and hold', async () => {
    const { stdout } = await runShell('printf "one\\ntwo\\n" | sed -n -e "1h" -e "1d" -e "2x" -e "2p" -e "2x" -e "2p"\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], 'one');
    assert.strictEqual(lines[1], 'two');
  });

  it('b: branch to end skips remaining commands', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sed "/b/b; s/$/_end/"\n');
    assert.ok(stdout.includes('a_end'));
    assert.ok(stdout.includes('b'));
    assert.ok(!stdout.includes('b_end'));
    assert.ok(stdout.includes('c_end'));
  });

  it(':label and b label: branch to label', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sed "/b/b skip; s/$/_ok/; :skip"\n');
    assert.ok(stdout.includes('a_ok'));
    assert.ok(!stdout.includes('b_ok'));
    assert.ok(stdout.includes('c_ok'));
  });
});

// =============================================================================
// find
// =============================================================================

describe('find', () => {
  it('finds files by name', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/find_target.txt\nfind /tmp -name "find_target.txt"\n'
    );
    assert.ok(stdout.includes('find_target.txt'));
  });

  it('finds directory by type', async () => {
    const { stdout } = await runShell(
      'mkdir /tmp/find_dir\nfind /tmp -name "find_dir" -type d\n'
    );
    assert.ok(stdout.includes('find_dir'));
  });

  it('finds file by type', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/find_ftype.txt\nfind /tmp -name "find_ftype.txt" -type f\n'
    );
    assert.ok(stdout.includes('find_ftype.txt'));
  });

  it('returns exit 0 when match found', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/find_exit.txt\nfind /tmp -name "find_exit.txt"\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('returns empty output for no match', async () => {
    const { stdout } = await runShell('find /tmp -name "no_such_find_file_xyz.txt"\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('-exec runs command on each match', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/find_exec.txt\nfind /tmp -name "find_exec.txt" -exec echo found {} \\;\n'
    );
    assert.ok(stdout.includes('found'));
  });

  it('wildcard in -name', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/find_wild1.log\necho y > /tmp/find_wild2.log\nfind /tmp -name "find_wild*.log"\n'
    );
    assert.ok(stdout.includes('find_wild1.log'));
    assert.ok(stdout.includes('find_wild2.log'));
  });

  it('lists all files recursively without predicates', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/findtest/sub\necho a > /tmp/findtest/file1.txt\necho b > /tmp/findtest/sub/file2.txt\nfind /tmp/findtest\n'
    );
    assert.ok(stdout.includes('findtest'));
    assert.ok(stdout.includes('file1.txt'));
    assert.ok(stdout.includes('file2.txt'));
    assert.ok(stdout.includes('sub'));
  });
});

describe('find glob patterns', () => {
  it('find -name with ? single-char glob', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fg && echo x > /tmp/fg/ab && echo x > /tmp/fg/abc\nfind /tmp/fg -name "?b"\n'
    );
    assert.ok(stdout.includes('ab'));
    assert.ok(!stdout.includes('abc'));
  });

  it('find -name with [...] character class', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fc && echo x > /tmp/fc/cat && echo x > /tmp/fc/bat && echo x > /tmp/fc/rat\nfind /tmp/fc -name "[cb]at"\n'
    );
    assert.ok(stdout.includes('cat'));
    assert.ok(stdout.includes('bat'));
    assert.ok(!stdout.includes('rat'));
  });
});

// =============================================================================
// find -path
// =============================================================================

describe('find -path', () => {
  it('matches full path with glob', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fp/sub\necho x > /tmp/fp/sub/file.txt\necho y > /tmp/fp/top.txt\nfind /tmp/fp -path "*/sub/*"\n'
    );
    assert.ok(stdout.includes('sub/file.txt'));
    assert.ok(!stdout.includes('top.txt'));
  });

  it('matches path with wildcard prefix', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fp2/deep/nested\necho a > /tmp/fp2/deep/nested/data.log\necho b > /tmp/fp2/other.log\nfind /tmp/fp2 -path "*nested*"\n'
    );
    assert.ok(stdout.includes('nested'));
    assert.ok(!stdout.includes('other.log'));
  });
});

// =============================================================================
// find -maxdepth
// =============================================================================

describe('find -maxdepth', () => {
  it('-maxdepth 0 returns only starting point', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fmd/child\necho x > /tmp/fmd/child/file.txt\nfind /tmp/fmd -maxdepth 0\n'
    );
    assert.strictEqual(stdout.trim(), '/tmp/fmd');
  });

  it('-maxdepth 1 returns starting point and direct children', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fmd1/sub\necho x > /tmp/fmd1/top.txt\necho y > /tmp/fmd1/sub/deep.txt\nfind /tmp/fmd1 -maxdepth 1\n'
    );
    assert.ok(stdout.includes('/tmp/fmd1'));
    assert.ok(stdout.includes('sub') || stdout.includes('top.txt'));
    assert.ok(!stdout.includes('deep.txt'));
  });

  it('-maxdepth 1 with -type f only shows files at depth 1', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/fmd2/sub\necho a > /tmp/fmd2/a.txt\necho b > /tmp/fmd2/sub/b.txt\nfind /tmp/fmd2 -maxdepth 1 -type f\n'
    );
    assert.ok(stdout.includes('a.txt'));
    assert.ok(!stdout.includes('b.txt'));
  });
});

// =============================================================================
// find -mtime
// =============================================================================

describe('find -mtime', () => {
  it('-mtime flag is accepted without error', async () => {
    const { exit } = await runShell(
      'mkdir -p /tmp/fmt\necho x > /tmp/fmt/file.txt\nfind /tmp/fmt -mtime +7\n'
    );
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// sort -k and -t (additional tests)
// =============================================================================

describe('sort -k field selection', () => {
  it('-k 2 sorts by second field onwards', async () => {
    const { stdout } = await runShell(
      'printf "b 2 x\\na 1 z\\nc 3 y\\n" | sort -k 2\n'
    );
    assert.strictEqual(stdout.trim(), 'a 1 z\nb 2 x\nc 3 y');
  });

  it('-k 2,2 sorts by only the second field', async () => {
    const { stdout } = await runShell(
      'printf "c banana\\na cherry\\nb apple\\n" | sort -k 2,2\n'
    );
    assert.strictEqual(stdout.trim(), 'b apple\nc banana\na cherry');
  });

  it('-t: -k 2 sorts by second colon-delimited field', async () => {
    const { stdout } = await runShell(
      'printf "root:0:desc\\nuser:2:info\\nadmin:1:note\\n" | sort -t: -k 2\n'
    );
    assert.strictEqual(stdout.trim(), 'root:0:desc\nadmin:1:note\nuser:2:info');
  });

  it('-t, -k 2,2n numeric sort on second comma-delimited field', async () => {
    const { stdout } = await runShell(
      'printf "x,10\\ny,2\\nz,1\\n" | sort -t, -k 2,2n\n'
    );
    assert.strictEqual(stdout.trim(), 'z,1\ny,2\nx,10');
  });
});

// =============================================================================
// diff
// =============================================================================

describe('diff', () => {
  it('exits 0 for identical files', async () => {
    const { exit } = await runShell(
      'echo "same" > /tmp/diff_a.txt\necho "same" > /tmp/diff_b.txt\ndiff /tmp/diff_a.txt /tmp/diff_b.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('exits 1 for different files', async () => {
    const { exit } = await runShell(
      'echo "aaa" > /tmp/diff_x.txt\necho "bbb" > /tmp/diff_y.txt\ndiff /tmp/diff_x.txt /tmp/diff_y.txt\n'
    );
    assert.strictEqual(exit, 1);
  });

  it('shows difference in output', async () => {
    const { stdout } = await runShell(
      'echo "old" > /tmp/diff_old.txt\necho "new" > /tmp/diff_new.txt\ndiff /tmp/diff_old.txt /tmp/diff_new.txt\n'
    );
    assert.ok(stdout.length > 0);
  });

  it('empty output for identical files', async () => {
    const { stdout } = await runShell(
      'echo "abc" > /tmp/diff_same1.txt\necho "abc" > /tmp/diff_same2.txt\ndiff /tmp/diff_same1.txt /tmp/diff_same2.txt\n'
    );
    assert.strictEqual(stdout.trim(), '');
  });

  it('exits non-zero for missing file', async () => {
    const { exit } = await runShell(
      'echo "x" > /tmp/diff_exists.txt\ndiff /tmp/diff_exists.txt /tmp/no_such_diff_file\n'
    );
    assert.notStrictEqual(exit, 0);
  });

  it('unified format with -u', async () => {
    const { stdout } = await runShell(
      'echo "old" > /tmp/diff_u_old.txt\necho "new" > /tmp/diff_u_new.txt\ndiff -u /tmp/diff_u_old.txt /tmp/diff_u_new.txt\n'
    );
    assert.ok(stdout.includes('---') || stdout.includes('+++'));
  });
});

// =============================================================================
// date
// =============================================================================

describe('date', () => {
  it('outputs a non-empty string', async () => {
    const { stdout } = await runShell('date\n');
    assert.ok(stdout.trim().length > 0);
  });

  it('exit code is 0', async () => {
    const { exit } = await runShell('date\n');
    assert.strictEqual(exit, 0);
  });

  it('+%Y format outputs 4-digit year', async () => {
    const { stdout } = await runShell('date "+%Y"\n');
    assert.match(stdout.trim(), /^\d{4}$/);
  });

  it('+%m format outputs 2-digit month', async () => {
    const { stdout } = await runShell('date "+%m"\n');
    assert.match(stdout.trim(), /^\d{2}$/);
    const month = parseInt(stdout.trim());
    assert.ok(month >= 1 && month <= 12);
  });

  it('+%d format outputs 2-digit day', async () => {
    const { stdout } = await runShell('date "+%d"\n');
    assert.match(stdout.trim(), /^\d{2}$/);
    const day = parseInt(stdout.trim());
    assert.ok(day >= 1 && day <= 31);
  });

  it('+%H:%M format outputs HH:MM', async () => {
    const { stdout } = await runShell('date "+%H:%M"\n');
    assert.match(stdout.trim(), /^\d{2}:\d{2}$/);
  });

  it('+%s outputs epoch seconds as a number', async () => {
    const { stdout } = await runShell('date "+%s"\n');
    assert.match(stdout.trim(), /^\d+$/);
    const epoch = parseInt(stdout.trim());
    assert.ok(epoch > 1000000000, `epoch ${epoch} should be > 1 billion`);
  });

  it('+%Y-%m-%d outputs combined date format', async () => {
    const { stdout } = await runShell('date "+%Y-%m-%d"\n');
    assert.match(stdout.trim(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it('+%% outputs literal percent', async () => {
    const { stdout } = await runShell('date "+%%"\n');
    assert.strictEqual(stdout.trim(), '%');
  });

  it('+%A outputs full weekday name', async () => {
    const { stdout } = await runShell('date "+%A"\n');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    assert.ok(days.includes(stdout.trim()), `"${stdout.trim()}" should be a weekday name`);
  });

  it('+%B outputs full month name', async () => {
    const { stdout } = await runShell('date "+%B"\n');
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    assert.ok(months.includes(stdout.trim()), `"${stdout.trim()}" should be a month name`);
  });

  it('+%Z outputs timezone abbreviation', async () => {
    const { stdout } = await runShell('date "+%Z"\n');
    assert.strictEqual(stdout.trim(), 'UTC');
  });
});

// =============================================================================
// sleep
// =============================================================================

describe('sleep', () => {
  it('sleep 0 completes with exit 0', async () => {
    const { exit } = await runShell('sleep 0\n');
    assert.strictEqual(exit, 0);
  });

  it('sleep 0.1 completes with exit 0', async () => {
    const { exit } = await runShell('sleep 0.1\n');
    assert.strictEqual(exit, 0);
  });

  it('sleep actually blocks for the specified duration', async () => {
    const start = Date.now();
    const { exit } = await runShell('sleep 0.3\n');
    const elapsed = Date.now() - start;
    assert.strictEqual(exit, 0);
    assert.ok(elapsed >= 250, `sleep took ${elapsed}ms, expected >= 250ms`);
  });
});
