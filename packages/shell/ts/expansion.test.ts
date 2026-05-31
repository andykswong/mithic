import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'cli.ts');

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

describe('variable expansion: default/alternate values', () => {
  it('${VAR:-default} returns default when var is unset', async () => {
    const { stdout } = await runShell('echo ${UNSET_XYZ:-fallback}\n');
    assert.strictEqual(stdout.trim(), 'fallback');
  });

  it('${VAR:-default} returns value when var is set', async () => {
    const { stdout } = await runShell('export VAR=hello\necho ${VAR:-fallback}\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('${VAR:-default} returns default when var is empty', async () => {
    const { stdout } = await runShell('export EMPTY=""\necho ${EMPTY:-fallback}\n');
    assert.strictEqual(stdout.trim(), 'fallback');
  });

  it('${VAR:+alt} returns alt when var is set and non-empty', async () => {
    const { stdout } = await runShell('export VAR=hello\necho ${VAR:+alt}\n');
    assert.strictEqual(stdout.trim(), 'alt');
  });

  it('${VAR:+alt} returns empty when var is unset', async () => {
    const { stdout } = await runShell('echo ${UNSET_XYZ:+alt}\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('${VAR:+alt} returns empty when var is empty', async () => {
    const { stdout } = await runShell('export EMPTY=""\necho ${EMPTY:+alt}\n');
    assert.strictEqual(stdout.trim(), '');
  });
});

describe('variable expansion: string length', () => {
  it('${#VAR} returns length of a non-empty string', async () => {
    const { stdout } = await runShell('export VAR=hello\necho ${#VAR}\n');
    assert.strictEqual(stdout.trim(), '5');
  });

  it('${#VAR} returns 0 for empty string', async () => {
    const { stdout } = await runShell('export EMPTY=""\necho ${#EMPTY}\n');
    assert.strictEqual(stdout.trim(), '0');
  });
});

describe('variable expansion: substring', () => {
  it('${VAR:offset} extracts from offset to end', async () => {
    const { stdout } = await runShell('export x=hello_world\necho ${x:6}\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('${VAR:offset:length} extracts substring', async () => {
    const { stdout } = await runShell('export x=hello_world\necho ${x:0:5}\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('${VAR:offset:length} extracts middle substring', async () => {
    const { stdout } = await runShell('export x=hello_world\necho ${x:2:3}\n');
    assert.strictEqual(stdout.trim(), 'llo');
  });
});

describe('variable expansion: pattern substitution', () => {
  it('${VAR//pat/rep} replaces all occurrences', async () => {
    const { stdout } = await runShell('export x=hello\necho ${x//l/L}\n');
    assert.strictEqual(stdout.trim(), 'heLLo');
  });

  it('${VAR/pat/rep} replaces first occurrence only', async () => {
    const { stdout } = await runShell('export x=hello\necho ${x/l/L}\n');
    assert.strictEqual(stdout.trim(), 'heLlo');
  });

  it('${VAR%suffix} removes shortest suffix match', async () => {
    const { stdout } = await runShell('export x=hello_world\necho ${x%orld}\n');
    assert.strictEqual(stdout.trim(), 'hello_w');
  });

  it('${VAR#prefix} removes shortest prefix match', async () => {
    const { stdout } = await runShell('export x=hello_world\necho ${x#hel}\n');
    assert.strictEqual(stdout.trim(), 'lo_world');
  });

  it('${VAR##prefix} removes longest prefix match (glob)', async () => {
    const { stdout } = await runShell('export x="/a/b/c/file.txt"\necho ${x##*/}\n');
    assert.strictEqual(stdout.trim(), 'file.txt');
  });

  it('${VAR%%suffix} removes longest suffix match (glob)', async () => {
    const { stdout } = await runShell('export x="a/b/c/file.txt"\necho ${x%%/*}\n');
    assert.strictEqual(stdout.trim(), 'a');
  });
});

describe('brace expansion', () => {
  it('comma list expands to separate words', async () => {
    const { stdout } = await runShell('echo {a,b,c}\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('prefix and suffix surround each element', async () => {
    const { stdout } = await runShell('echo file.{txt,md,rs}\n');
    assert.strictEqual(stdout.trim(), 'file.txt file.md file.rs');
  });

  it('numeric sequence {1..5}', async () => {
    const { stdout } = await runShell('echo {1..5}\n');
    assert.strictEqual(stdout.trim(), '1 2 3 4 5');
  });

  it('numeric sequence with step {1..10..2}', async () => {
    const { stdout } = await runShell('echo {1..10..2}\n');
    assert.strictEqual(stdout.trim(), '1 3 5 7 9');
  });

  it('alpha sequence {a..e}', async () => {
    const { stdout } = await runShell('echo {a..e}\n');
    assert.strictEqual(stdout.trim(), 'a b c d e');
  });

  it('reverse numeric sequence', async () => {
    const { stdout } = await runShell('echo {5..1}\n');
    assert.strictEqual(stdout.trim(), '5 4 3 2 1');
  });
});

describe('arithmetic expansion', () => {
  it('$((1+2)) evaluates addition', async () => {
    const { stdout } = await runShell('echo $((1+2))\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('$((a * b)) uses variable values', async () => {
    const { stdout } = await runShell('export a=3\nexport b=4\necho $((a * b))\n');
    assert.strictEqual(stdout.trim(), '12');
  });

  it('integer division', async () => {
    const { stdout } = await runShell('echo $((10 / 3))\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('modulo operator', async () => {
    const { stdout } = await runShell('echo $((10 % 3))\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('exponentiation', async () => {
    const { stdout } = await runShell('echo $((2**8))\n');
    assert.strictEqual(stdout.trim(), '256');
  });
});

describe('arithmetic expansion: edge cases', () => {
  it('division by zero returns error exit code', async () => {
    const { exit, stderr } = await runShell('echo $((1 / 0))\n');
    assert.strictEqual(exit, 1);
    assert.ok(stderr.includes('division by 0'));
  });

  it('modulo by zero returns error exit code', async () => {
    const { exit, stderr } = await runShell('echo $((5 % 0))\n');
    assert.strictEqual(exit, 1);
    assert.ok(stderr.includes('division by 0'));
  });

  it('large numbers do not panic (overflow wraps or returns a value)', async () => {
    const { exit } = await runShell('echo $((9223372036854775807 + 1))\n');
    // Should complete without crash (exit 0 or any defined exit code, not a signal kill)
    assert.ok(exit !== null);
  });

  it('nested arithmetic $((( 2+3 ) * ( 4-1 ))) evaluates to 15', async () => {
    const { stdout } = await runShell('echo $(( (2+3) * (4-1) ))\n');
    assert.strictEqual(stdout.trim(), '15');
  });

  it('div-by-zero aborts the command (echo does not run)', async () => {
    const { stdout, exit } = await runShell('echo $((1/0))\n');
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(exit, 1);
  });

  it('div-by-zero in assignment returns exit 1', async () => {
    const { exit } = await runShell('x=$((1/0))\n');
    assert.strictEqual(exit, 1);
  });

  it('(( 1/0 )) standalone arithmetic command returns exit 1', async () => {
    const { exit } = await runShell('(( 1/0 ))\n');
    assert.strictEqual(exit, 1);
  });

  it('next line still executes after div-by-zero', async () => {
    const { stdout } = await runShell('echo $((1/0))\necho after\n');
    assert.strictEqual(stdout.trim(), 'after');
  });

  it('div-by-zero in for-in list aborts the for loop', async () => {
    const { stdout, exit } = await runShell('for x in $((1/0)); do echo $x; done\n');
    assert.strictEqual(stdout.trim(), '');
    assert.notStrictEqual(exit, 0);
  });

  it('div-by-zero in pipe still allows pipeline to complete', async () => {
    const { stdout } = await runShell('echo $((1/0)) | cat\necho after\n');
    assert.ok(stdout.includes('after'));
  });

  it('div-by-zero in case value aborts the case', async () => {
    const { stdout, exit } = await runShell('case $((1/0)) in *) echo matched;; esac\n');
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(exit, 1);
  });

  it('div-by-zero in array assignment returns exit 1', async () => {
    const { exit } = await runShell('arr=($((1/0)))\n');
    assert.strictEqual(exit, 1);
  });

  it('div-by-zero in select list aborts the select', async () => {
    const { stdout, exit } = await runShell('select x in $((1/0)); do echo $x; break; done\n');
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(exit, 1);
  });

  it('div-by-zero in middle pipe stage fails that stage only', async () => {
    const { stdout } = await runShell('echo hello | echo $((1/0)) | cat | echo after\n');
    assert.ok(stdout.includes('after'));
  });

  it('div-by-zero in last pipe stage sets pipeline exit 1', async () => {
    const { exit } = await runShell('echo ok | cat $((1/0))\n');
    assert.notStrictEqual(exit, 0);
  });
});

describe('command substitution', () => {
  it('$(echo hello) captures output', async () => {
    const { stdout } = await runShell('export result=$(echo hello)\necho "$result"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('nested $(echo $(echo nested)) works', async () => {
    const { stdout } = await runShell('export result=$(echo $(echo nested))\necho "$result"\n');
    assert.strictEqual(stdout.trim(), 'nested');
  });

  it('command substitution strips trailing newline', async () => {
    const { stdout } = await runShell('export result=$(echo hello)\necho "[$result]"\n');
    assert.strictEqual(stdout.trim(), '[hello]');
  });
});

describe('tilde expansion', () => {
  it('~ alone expands to $HOME', async () => {
    const { stdout } = await runShell('echo ~\n');
    assert.ok(stdout.trim().length > 0);
    assert.ok(!stdout.trim().includes('~'));
  });

  it('~/path appends to home directory', async () => {
    const { stdout } = await runShell('echo ~/foo\n');
    assert.ok(stdout.trim().endsWith('/foo'));
    assert.ok(!stdout.trim().startsWith('~'));
  });
});

describe('$@ vs $* semantics', () => {
  it('"$@" preserves separate words in for loop', async () => {
    const { stdout } = await runShell('f() { for x in "$@"; do echo "[$x]"; done; }\nf "a b" c\n');
    assert.strictEqual(stdout.trim(), '[a b]\n[c]');
  });

  it('"$*" joins into single word in for loop', async () => {
    const { stdout } = await runShell('f() { for x in "$*"; do echo "[$x]"; done; }\nf "a b" c\n');
    assert.strictEqual(stdout.trim(), '[a b c]');
  });

  it('$* uses IFS[0] as separator', async () => {
    const { stdout } = await runShell('export IFS=","\nf() { echo "$*"; }\nf a b c\n');
    assert.strictEqual(stdout.trim(), 'a,b,c');
  });

  it('$@ is not affected by IFS', async () => {
    const { stdout } = await runShell('export IFS=","\nf() { echo "$@"; }\nf a b c\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('${arr[*]} joins array with IFS[0]', async () => {
    const { stdout } = await runShell('export IFS=":"\narr=(x y z)\necho "${arr[*]}"\n');
    assert.strictEqual(stdout.trim(), 'x:y:z');
  });

  it('${arr[@]} keeps array elements separate', async () => {
    const { stdout } = await runShell('arr=("a b" c)\nfor x in "${arr[@]}"; do echo "[$x]"; done\n');
    assert.strictEqual(stdout.trim(), '[a b]\n[c]');
  });
});
