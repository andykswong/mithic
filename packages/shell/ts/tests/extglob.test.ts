import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShellMode(script: string, mode: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const args = mode === 'async' ? [CLI, '--async'] : [CLI];
    const child = spawn('node', args, {
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

for (const mode of ['worker', 'async']) {
  describe(`extglob (${mode} mode)`, () => {
    const runShell = (script: string) => runShellMode(script, mode);

    it('extglob disabled by default - [[ ]] does not use extglob', async () => {
      const { stdout } = await runShell(`
[[ foo == @(foo) ]] && echo matched || echo nomatch
`);
      assert.strictEqual(stdout.trim(), 'nomatch', 'without extglob, @(foo) should not match in [[ ]]');
    });

    it('shopt -s extglob enables @() in case', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
x="foo"
case "$x" in
  @(foo|bar)) echo matched;;
  *) echo nomatch;;
esac
`);
      assert.strictEqual(stdout.trim(), 'matched');
    });

    it('@() matches exactly one alternative', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in foo bar baz foobar; do
  case "$x" in
    @(foo|bar)) echo "Y $x";;
    *) echo "N $x";;
  esac
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Y foo');
      assert.strictEqual(lines[1], 'Y bar');
      assert.strictEqual(lines[2], 'N baz');
      assert.strictEqual(lines[3], 'N foobar');
    });

    it('?() matches zero or one occurrence', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in "" foo foofoo bar; do
  [[ "$x" == ?(foo) ]] && echo "Y $x" || echo "N $x"
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Y ');
      assert.strictEqual(lines[1], 'Y foo');
      assert.strictEqual(lines[2], 'N foofoo');
      assert.strictEqual(lines[3], 'N bar');
    });

    it('*() matches zero or more occurrences', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in "" foo foofoo bar foobar; do
  [[ "$x" == *(foo) ]] && echo "Y $x" || echo "N $x"
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Y ');
      assert.strictEqual(lines[1], 'Y foo');
      assert.strictEqual(lines[2], 'Y foofoo');
      assert.strictEqual(lines[3], 'N bar');
      assert.strictEqual(lines[4], 'N foobar');
    });

    it('+() matches one or more occurrences', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in "" foo foofoo bar; do
  [[ "$x" == +(foo) ]] && echo "Y $x" || echo "N $x"
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'N ');
      assert.strictEqual(lines[1], 'Y foo');
      assert.strictEqual(lines[2], 'Y foofoo');
      assert.strictEqual(lines[3], 'N bar');
    });

    it('!() matches anything except the patterns', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in foo bar baz; do
  [[ "$x" == !(foo|bar) ]] && echo "Y $x" || echo "N $x"
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'N foo');
      assert.strictEqual(lines[1], 'N bar');
      assert.strictEqual(lines[2], 'Y baz');
    });

    it('extglob in [[ ]] conditional', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
x="file.txt"
[[ "$x" == @(*.txt|*.rs) ]] && echo matched || echo nomatch
`);
      assert.strictEqual(stdout.trim(), 'matched');
    });

    it('extglob in parameter expansion ${var#pattern}', async () => {
      const { stdout } = await runShell(
        'shopt -s extglob\nx="foobarfoo"\necho "${x#@(foo|bar)}"\necho "end"\n'
      );
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'barfoo');
      assert.strictEqual(lines[1], 'end');
    });

    it('extglob in parameter expansion ${var##pattern}', async () => {
      const { stdout } = await runShell(
        'shopt -s extglob\nx="foobarfoo"\necho "${x##+(foo|bar)}"\necho "end"\n'
      );
      const lines = stdout.trimEnd().split('\n');
      assert.strictEqual(lines[0], '');
      assert.strictEqual(lines[1], 'end');
    });

    it('extglob in parameter expansion ${var%pattern}', async () => {
      const { stdout } = await runShell(
        'shopt -s extglob\nx="foobarfoo"\necho "${x%@(foo|bar)}"\necho "end"\n'
      );
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'foobar');
      assert.strictEqual(lines[1], 'end');
    });

    it('extglob in parameter expansion ${var%%pattern}', async () => {
      const { stdout } = await runShell(
        'shopt -s extglob\nx="foobarfoo"\necho "${x%%+(foo|bar)}"\necho "end"\n'
      );
      const lines = stdout.trimEnd().split('\n');
      assert.strictEqual(lines[0], '');
      assert.strictEqual(lines[1], 'end');
    });

    it('extglob in ${var/pattern/replacement}', async () => {
      const { stdout } = await runShell(
        'shopt -s extglob\nx="foobarfoo"\necho "${x/@(foo|bar)/X}"\necho "${x//@(foo|bar)/X}"\n'
      );
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Xbarfoo');
      assert.strictEqual(lines[1], 'XXX');
    });

    it('shopt -u extglob disables extglob again', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
shopt -u extglob
x="foo"
case "$x" in
  @(foo|bar)) echo matched;;
  *) echo nomatch;;
esac
`);
      assert.strictEqual(stdout.trim(), 'nomatch');
    });

    it('extglob with prefix and suffix', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
for x in foobar foobaz fooqux; do
  [[ "$x" == foo@(bar|baz) ]] && echo "Y $x" || echo "N $x"
done
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Y foobar');
      assert.strictEqual(lines[1], 'Y foobaz');
      assert.strictEqual(lines[2], 'N fooqux');
    });

    it('*() with multiple alternatives', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
[[ "foobar" == *(foo|bar) ]] && echo Y || echo N
[[ "barfoobar" == *(foo|bar) ]] && echo Y || echo N
[[ "foobaz" == *(foo|bar) ]] && echo Y || echo N
`);
      const lines = stdout.trim().split('\n');
      assert.strictEqual(lines[0], 'Y');
      assert.strictEqual(lines[1], 'Y');
      assert.strictEqual(lines[2], 'N');
    });

    it('extglob in file glob expansion', async () => {
      const { stdout } = await runShell(`
shopt -s extglob
mkdir -p /tmp/extglobtest
touch /tmp/extglobtest/file.txt
touch /tmp/extglobtest/file.rs
touch /tmp/extglobtest/file.py
cd /tmp/extglobtest
echo @(*.txt|*.rs)
`);
      const result = stdout.trim();
      assert.ok(result.includes('file.txt'), 'should match .txt');
      assert.ok(result.includes('file.rs'), 'should match .rs');
      assert.ok(!result.includes('file.py'), 'should not match .py');
    });
  });

  describe(`globstar (${mode} mode)`, () => {
    const runShell = (script: string) => runShellMode(script, mode);

    it('globstar disabled by default - ** behaves as *', async () => {
      const { stdout } = await runShell(`
mkdir -p /tmp/gstest/sub
touch /tmp/gstest/a.txt
touch /tmp/gstest/sub/b.txt
cd /tmp/gstest
echo **
`);
      const result = stdout.trim();
      assert.ok(result.includes('a.txt') || result.includes('sub'), 'should match top-level');
      assert.ok(!result.includes('sub/b.txt'), 'without globstar ** should not recurse');
    });

    it('shopt -s globstar enables recursive matching', async () => {
      const { stdout } = await runShell(`
shopt -s globstar
mkdir -p /tmp/gstest2/sub/deep
touch /tmp/gstest2/a.txt
touch /tmp/gstest2/sub/b.txt
touch /tmp/gstest2/sub/deep/c.txt
cd /tmp/gstest2
echo **/*.txt
`);
      const result = stdout.trim();
      assert.ok(result.includes('a.txt'), 'should match top-level .txt');
      assert.ok(result.includes('sub/b.txt'), 'should match nested .txt');
      assert.ok(result.includes('sub/deep/c.txt'), 'should match deeply nested .txt');
    });

    it('globstar with prefix dir', async () => {
      const { stdout } = await runShell(`
shopt -s globstar
mkdir -p /tmp/gstest3/src/pkg
touch /tmp/gstest3/src/main.rs
touch /tmp/gstest3/src/pkg/lib.rs
cd /tmp/gstest3
echo src/**/*.rs
`);
      const result = stdout.trim();
      assert.ok(result.includes('src/main.rs'), 'should match direct child');
      assert.ok(result.includes('src/pkg/lib.rs'), 'should match nested child');
    });

    it('combined extglob and globstar', async () => {
      const { stdout } = await runShell(`
shopt -s extglob globstar
mkdir -p /tmp/gstest4/sub
touch /tmp/gstest4/file.txt
touch /tmp/gstest4/file.rs
touch /tmp/gstest4/file.py
touch /tmp/gstest4/sub/code.rs
touch /tmp/gstest4/sub/code.py
cd /tmp/gstest4
echo **/@(*.txt|*.rs)
`);
      const result = stdout.trim();
      assert.ok(result.includes('file.txt'), 'should match top .txt');
      assert.ok(result.includes('file.rs'), 'should match top .rs');
      assert.ok(result.includes('sub/code.rs'), 'should match nested .rs');
      assert.ok(!result.includes('file.py'), 'should not match .py');
      assert.ok(!result.includes('code.py'), 'should not match nested .py');
    });

    it('shopt -u globstar disables it', async () => {
      const { stdout } = await runShell('shopt -s globstar\nshopt -u globstar\nshopt -q globstar\necho $?\n');
      assert.strictEqual(stdout.trim(), '1');
    });
  });
}
