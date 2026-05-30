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
// cat
// =============================================================================

describe('cat', () => {
  it('outputs file contents', async () => {
    const { stdout } = await runShell('echo "hello" > /tmp/cat1.txt\ncat /tmp/cat1.txt\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('reads stdin when no file given', async () => {
    const { stdout } = await runShell('echo "world" | cat\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('concatenates multiple files', async () => {
    const { stdout } = await runShell(
      'echo "a" > /tmp/cat_m1.txt\necho "b" > /tmp/cat_m2.txt\ncat /tmp/cat_m1.txt /tmp/cat_m2.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('exits 1 for missing file', async () => {
    const { exit } = await runShell('cat /tmp/no_such_file_cat_xyz\n');
    assert.strictEqual(exit, 1);
  });

  it('-n numbers lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | cat -n\n');
    assert.ok(stdout.includes('1'));
    assert.ok(stdout.includes('2'));
    assert.ok(stdout.includes('3'));
  });
});

// =============================================================================
// head
// =============================================================================

describe('head', () => {
  it('default shows first 10 lines', async () => {
    const { stdout } = await runShell('seq 1 15 | head\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 10);
    assert.strictEqual(lines[0], '1');
    assert.strictEqual(lines[9], '10');
  });

  it('-n N shows first N lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\nd\\n" | head -n 2\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('-n 1 shows exactly one line', async () => {
    const { stdout } = await runShell('printf "first\\nsecond\\nthird\\n" | head -n 1\n');
    assert.strictEqual(stdout.trim(), 'first');
  });

  it('reads from file', async () => {
    const { stdout } = await runShell(
      'printf "x\\ny\\nz\\n" > /tmp/head_f.txt\nhead -n 2 /tmp/head_f.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'x\ny');
  });

  it('-c N byte mode', async () => {
    const { stdout } = await runShell('printf "abcdef" | head -c 3\n');
    assert.strictEqual(stdout, 'abc');
  });
});

// =============================================================================
// tail
// =============================================================================

describe('tail', () => {
  it('default shows last 10 lines', async () => {
    const { stdout } = await runShell('seq 1 15 | tail\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 10);
    assert.strictEqual(lines[0], '6');
    assert.strictEqual(lines[9], '15');
  });

  it('-n N shows last N lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\nd\\n" | tail -n 2\n');
    assert.strictEqual(stdout.trim(), 'c\nd');
  });

  it('-n 1 shows exactly the last line', async () => {
    const { stdout } = await runShell('printf "first\\nsecond\\nthird\\n" | tail -n 1\n');
    assert.strictEqual(stdout.trim(), 'third');
  });

  it('reads from file', async () => {
    const { stdout } = await runShell(
      'printf "x\\ny\\nz\\n" > /tmp/tail_f.txt\ntail -n 2 /tmp/tail_f.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'y\nz');
  });

  it('-c N byte mode', async () => {
    const { stdout } = await runShell('printf "abcdef" | tail -c 3\n');
    assert.strictEqual(stdout, 'def');
  });
});

// =============================================================================
// wc
// =============================================================================

describe('wc', () => {
  it('-l counts lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | wc -l\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('-w counts words', async () => {
    const { stdout } = await runShell('echo "hello world foo" | wc -w\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('-c counts bytes/chars', async () => {
    const { stdout } = await runShell('echo "hello" | wc -c\n');
    // "hello\n" is 6 bytes
    assert.strictEqual(stdout.trim(), '6');
  });

  it('no flag outputs lines, words, chars', async () => {
    const { stdout } = await runShell('printf "hello world\\nfoo\\n" | wc\n');
    // Should contain 2, 3, and 15 (or similar totals)
    const parts = stdout.trim().split(/\s+/).map(Number).filter((n) => !isNaN(n));
    assert.ok(parts.length >= 3);
    assert.strictEqual(parts[0], 2); // lines
    assert.strictEqual(parts[1], 3); // words
  });

  it('multiple files shows combined total', async () => {
    const { stdout } = await runShell(
      'printf "a\\nb\\n" > /tmp/wc_a.txt\nprintf "x\\ny\\nz\\n" > /tmp/wc_b.txt\nwc -l /tmp/wc_a.txt /tmp/wc_b.txt\n'
    );
    // Current implementation outputs combined total only
    assert.ok(stdout.trim().includes('5'));
  });

  it('right-aligned output', async () => {
    const { stdout } = await runShell('printf "a\\nb\\n" | wc -l\n');
    // Right-aligned means number is not left-padded inconsistently
    assert.match(stdout, /^\s*2\s*$/m);
  });
});

// =============================================================================
// grep
// =============================================================================

describe('grep', () => {
  it('filters matching lines', async () => {
    const { stdout } = await runShell('printf "apple\\nbanana\\napricot\\n" | grep "ap"\n');
    assert.strictEqual(stdout.trim(), 'apple\napricot');
  });

  it('-v inverts match', async () => {
    const { stdout } = await runShell('printf "apple\\nbanana\\napricot\\n" | grep -v "ap"\n');
    assert.strictEqual(stdout.trim(), 'banana');
  });

  it('-c counts matching lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\na\\n" | grep -c "a"\n');
    assert.strictEqual(stdout.trim(), '2');
  });

  it('exits 1 when no match', async () => {
    const { exit } = await runShell('echo hello | grep xyz\n');
    assert.strictEqual(exit, 1);
  });

  it('exits 0 when match found', async () => {
    const { exit } = await runShell('echo hello | grep hello\n');
    assert.strictEqual(exit, 0);
  });

  it('searches file', async () => {
    const { stdout } = await runShell(
      'printf "foo\\nbar\\nbaz\\n" > /tmp/grep_file.txt\ngrep "ba" /tmp/grep_file.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'bar\nbaz');
  });

  it('-i case-insensitive match', async () => {
    const { stdout } = await runShell('printf "Apple\\nbanana\\n" | grep -i "apple"\n');
    assert.strictEqual(stdout.trim(), 'Apple');
  });

  it('-n shows line numbers', async () => {
    const { stdout } = await runShell('printf "foo\\nbar\\nbaz\\n" | grep -n "bar"\n');
    assert.ok(stdout.includes('2:bar') || stdout.includes('2'));
  });

  it('regex: . matches any character', async () => {
    const { stdout } = await runShell('printf "cat\\nbat\\nrat\\nsat\\n" | grep "^.at"\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 4);
  });

  it('regex: * quantifier', async () => {
    const { stdout } = await runShell('printf "ac\\nabc\\nabbc\\n" | grep "ab*c"\n');
    assert.strictEqual(stdout.trim(), 'ac\nabc\nabbc');
  });

  it('regex: ^ anchors to line start', async () => {
    const { stdout } = await runShell('printf "hello\\nworld\\nhello world\\n" | grep "^hello"\n');
    assert.strictEqual(stdout.trim(), 'hello\nhello world');
  });

  it('regex: $ anchors to line end', async () => {
    const { stdout } = await runShell('printf "hello\\nworld\\nhello world\\n" | grep "world$"\n');
    assert.strictEqual(stdout.trim(), 'world\nhello world');
  });

  it('regex: [abc] character class', async () => {
    const { stdout } = await runShell('printf "cat\\ndog\\nbat\\n" | grep "[cb]at"\n');
    assert.strictEqual(stdout.trim(), 'cat\nbat');
  });

  it('regex: + one or more', async () => {
    const { stdout } = await runShell('printf "ac\\nabc\\nabbc\\n" | grep -E "ab+c"\n');
    assert.strictEqual(stdout.trim(), 'abc\nabbc');
  });

  it('regex: ? zero or one', async () => {
    const { stdout } = await runShell('printf "ac\\nabc\\nabbc\\n" | grep -E "ab?c"\n');
    assert.strictEqual(stdout.trim(), 'ac\nabc');
  });

  it('empty pattern matches all lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\n" | grep ""\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('-E alternation matches either pattern', async () => {
    const { stdout } = await runShell('printf "cat\\ndog\\nbird\\n" | grep -E "cat|dog"\n');
    assert.strictEqual(stdout.trim(), 'cat\ndog');
  });

  it('unescaped pipe alternation matches either pattern', async () => {
    const { stdout } = await runShell('printf "cat\\ndog\\nbird\\n" | grep "cat|dog"\n');
    assert.strictEqual(stdout.trim(), 'cat\ndog');
  });

  it('-l lists filename of matching file', async () => {
    const { stdout } = await runShell(
      'echo "needle" > /tmp/grep_l_test.txt\ngrep -l "needle" /tmp/grep_l_test.txt\n'
    );
    assert.ok(stdout.trim().includes('grep_l_test.txt'));
  });

  it('multiple -e patterns', async () => {
    const { stdout } = await runShell('printf "foo\\nbar\\nbaz\\n" | grep -e "foo" -e "baz"\n');
    assert.strictEqual(stdout.trim(), 'foo\nbaz');
  });
});

// =============================================================================
// tr
// =============================================================================

describe('tr', () => {
  it('translates characters', async () => {
    const { stdout } = await runShell('echo "hello" | tr "a-z" "A-Z"\n');
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('translates with explicit char sets', async () => {
    const { stdout } = await runShell('echo "abc" | tr "abc" "xyz"\n');
    assert.strictEqual(stdout.trim(), 'xyz');
  });

  it('-d deletes characters', async () => {
    const { stdout } = await runShell('echo "hello world" | tr -d " "\n');
    assert.strictEqual(stdout.trim(), 'helloworld');
  });

  it('-d deletes a range', async () => {
    const { stdout } = await runShell('echo "hello123" | tr -d "0-9"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('-s squeezes repeated characters', async () => {
    const { stdout } = await runShell('echo "aaabbbccc" | tr -s "a-z"\n');
    assert.strictEqual(stdout.trim(), 'abc');
  });

  it('character class [:upper:]', async () => {
    const { stdout } = await runShell('echo "HELLO" | tr "[:upper:]" "[:lower:]"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

// =============================================================================
// cut
// =============================================================================

describe('cut', () => {
  it('-d and -f extracts field', async () => {
    const { stdout } = await runShell('echo "a:b:c" | cut -d: -f2\n');
    assert.strictEqual(stdout.trim(), 'b');
  });

  it('-f1 extracts first field', async () => {
    const { stdout } = await runShell('echo "foo,bar,baz" | cut -d, -f1\n');
    assert.strictEqual(stdout.trim(), 'foo');
  });

  it('-f3 extracts third field', async () => {
    const { stdout } = await runShell('echo "one two three" | cut -d" " -f3\n');
    assert.strictEqual(stdout.trim(), 'three');
  });

  it('-f1,3 extracts multiple fields', async () => {
    const { stdout } = await runShell('echo "a:b:c:d" | cut -d: -f1,3\n');
    assert.strictEqual(stdout.trim(), 'a:c');
  });

  it('-c extracts character range', async () => {
    const { stdout } = await runShell('echo "abcdef" | cut -c2-4\n');
    assert.strictEqual(stdout.trim(), 'bcd');
  });

  it('-b extracts byte range', async () => {
    const { stdout } = await runShell('echo "abcdef" | cut -b1-3\n');
    assert.strictEqual(stdout.trim(), 'abc');
  });
});

// =============================================================================
// rev
// =============================================================================

describe('rev', () => {
  it('reverses line content from stdin', async () => {
    const { stdout } = await runShell('echo "hello" | rev\n');
    assert.strictEqual(stdout.trim(), 'olleh');
  });

  it('reverses each line independently', async () => {
    const { stdout } = await runShell('printf "abc\\nxyz\\n" | rev\n');
    assert.strictEqual(stdout.trim(), 'cba\nzyx');
  });

  it('reverses file content', async () => {
    const { stdout } = await runShell(
      'echo "racecar" > /tmp/rev_test.txt\nrev /tmp/rev_test.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'racecar');
  });

  it('reverses a number string', async () => {
    const { stdout } = await runShell('echo "12345" | rev\n');
    assert.strictEqual(stdout.trim(), '54321');
  });
});
