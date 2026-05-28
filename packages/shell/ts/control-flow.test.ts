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

describe('if/elif/else/fi', () => {
  it('executes then branch when condition is true', async () => {
    const { stdout } = await runShell('if true; then echo yes; fi\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('executes else branch when condition is false', async () => {
    const { stdout } = await runShell('if false; then echo no; else echo yes; fi\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('handles elif chain', async () => {
    const { stdout } = await runShell(
      'if false; then echo 1; elif false; then echo 2; elif true; then echo 3; fi\n'
    );
    assert.strictEqual(stdout.trim(), '3');
  });

  it('returns exit code of last executed body', async () => {
    const { stdout } = await runShell('if true; then false; fi\necho $?\n');
    assert.strictEqual(stdout.trim(), '1');
  });
});

describe('for/in/do/done', () => {
  it('iterates over word list', async () => {
    const { stdout } = await runShell('for x in a b c; do echo $x; done\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('expands variables in word list', async () => {
    const { stdout } = await runShell('export items="hello world"\nfor x in $items; do echo $x; done\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('supports break', async () => {
    const { stdout } = await runShell(
      'for x in a b c d; do\nif [ $x = c ]; then break; fi\necho $x\ndone\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('supports continue', async () => {
    const { stdout } = await runShell(
      'for x in a b c d; do\nif [ $x = b ]; then continue; fi\necho $x\ndone\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nc\nd');
  });
});

describe('while/do/done', () => {
  it('loops while condition is true', async () => {
    // arithmetic expansion not yet implemented, so test with string comparison
    const { stdout } = await runShell(
      'export x=yes\nexport count=0\nwhile [ $x = yes ]; do\necho $count\nexport x=no\ndone\n'
    );
    assert.strictEqual(stdout.trim(), '0');
  });

  it('exits when condition becomes false', async () => {
    const { stdout } = await runShell(
      'export x=yes\nwhile [ $x = yes ]; do\necho loop\nexport x=no\ndone\n'
    );
    assert.strictEqual(stdout.trim(), 'loop');
  });
});

describe('case/esac', () => {
  it('matches literal pattern', async () => {
    const { stdout } = await runShell(
      'export x=hello\ncase $x in hi) echo no;; hello) echo yes;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('matches glob pattern', async () => {
    const { stdout } = await runShell(
      'export x=hello\ncase $x in h*) echo matched;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'matched');
  });

  it('matches multiple patterns with |', async () => {
    const { stdout } = await runShell(
      'export x=b\ncase $x in a|b) echo ab;; c) echo c;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'ab');
  });

  it('uses first matching arm only', async () => {
    const { stdout } = await runShell(
      'export x=hello\ncase $x in h*) echo first;; hello) echo second;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'first');
  });
});

describe('functions', () => {
  it('defines and calls a function', async () => {
    const { stdout } = await runShell('greet() { echo hello; }\ngreet\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('passes positional arguments', async () => {
    const { stdout } = await runShell('say() { echo $1 $2; }\nsay hello world\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('supports $# for argument count', async () => {
    const { stdout } = await runShell('count() { echo $#; }\ncount a b c\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('supports return', async () => {
    const { stdout } = await runShell(
      'early() { echo before; return 42; echo after; }\nearly\necho $?\n'
    );
    assert.strictEqual(stdout.trim(), 'before\n42');
  });

  it('restores positional params after call', async () => {
    const { stdout } = await runShell(
      'f() { echo $1; }\nexport x=outer\nf inner\necho $x\n'
    );
    assert.strictEqual(stdout.trim(), 'inner\nouter');
  });
});

describe('test/[ builtin', () => {
  it('string equality', async () => {
    const { exit } = await runShell('[ hello = hello ]\n');
    assert.strictEqual(exit, 0);
  });

  it('string inequality', async () => {
    const { exit } = await runShell('[ hello = world ]\n');
    assert.strictEqual(exit, 1);
  });

  it('-z empty string', async () => {
    const { exit } = await runShell('[ -z "" ]\n');
    assert.strictEqual(exit, 0);
  });

  it('-n non-empty string', async () => {
    const { exit } = await runShell('[ -n hello ]\n');
    assert.strictEqual(exit, 0);
  });

  it('integer comparison -lt', async () => {
    const { exit } = await runShell('[ 1 -lt 2 ]\n');
    assert.strictEqual(exit, 0);
  });

  it('integer comparison -gt', async () => {
    const { exit } = await runShell('[ 5 -gt 3 ]\n');
    assert.strictEqual(exit, 0);
  });

  it('integer comparison -eq', async () => {
    const { exit } = await runShell('[ 42 -eq 42 ]\n');
    assert.strictEqual(exit, 0);
  });

  it('negation with !', async () => {
    const { exit } = await runShell('[ ! -z hello ]\n');
    assert.strictEqual(exit, 0);
  });
});

describe('[[ extended test ]]', () => {
  it('pattern matching with ==', async () => {
    const { exit } = await runShell('export x=hello\n[[ $x == h* ]]\n');
    assert.strictEqual(exit, 0);
  });

  it('pattern not matching', async () => {
    const { exit } = await runShell('export x=hello\n[[ $x == w* ]]\n');
    assert.strictEqual(exit, 1);
  });

  it('string inequality !=', async () => {
    const { exit } = await runShell('export x=hello\n[[ $x != world ]]\n');
    assert.strictEqual(exit, 0);
  });
});

describe('until/do/done', () => {
  it('loops until condition is true', async () => {
    const { stdout } = await runShell(
      'export x=no\nuntil [ $x = yes ]; do\necho loop\nexport x=yes\ndone\n'
    );
    assert.strictEqual(stdout.trim(), 'loop');
  });
});

describe('edge cases', () => {
  it('break outside loop prints error', async () => {
    const { stderr } = await runShell('break\n');
    assert.ok(stderr.includes('only meaningful in a loop'));
  });

  it('continue outside loop prints error', async () => {
    const { stderr } = await runShell('continue\n');
    assert.ok(stderr.includes('only meaningful in a loop'));
  });

  it('return outside function prints error', async () => {
    const { stderr } = await runShell('return\n');
    assert.ok(stderr.includes('can only return'));
  });

  it('nested break 2 exits outer loop', async () => {
    const { stdout } = await runShell(
      'for i in a b; do\nfor j in 1 2 3; do\nif [ $j = 2 ]; then break 2; fi\necho $i$j\ndone\ndone\n'
    );
    assert.strictEqual(stdout.trim(), 'a1');
  });

  it('case with * default pattern', async () => {
    const { stdout } = await runShell(
      'export x=unknown\ncase $x in a) echo a;; *) echo default;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'default');
  });

  it('[[ with && operator', async () => {
    const { exit } = await runShell('export x=hello\n[[ -n $x && $x == h* ]]\n');
    assert.strictEqual(exit, 0);
  });

  it('[[ with || operator', async () => {
    const { exit } = await runShell('[[ -z "" || -n hello ]]\n');
    assert.strictEqual(exit, 0);
  });

  it('for without in clause uses positional params', async () => {
    const { stdout } = await runShell(
      'f() { for x; do echo $x; done; }\nf a b c\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });
});

describe('arrays', () => {
  it('assigns and indexes an array', async () => {
    const { stdout } = await runShell('arr=(hello world foo)\necho ${arr[0]}\necho ${arr[1]}\necho ${arr[2]}\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld\nfoo');
  });

  it('expands all elements with ${arr[@]}', async () => {
    const { stdout } = await runShell('arr=(a b c)\necho ${arr[@]}\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('gets array length with ${#arr[@]}', async () => {
    const { stdout } = await runShell('arr=(one two three four)\necho ${#arr[@]}\n');
    assert.strictEqual(stdout.trim(), '4');
  });

  it('modifies individual array elements', async () => {
    const { stdout } = await runShell('arr=(a b c)\narr[1]=X\necho ${arr[@]}\n');
    assert.strictEqual(stdout.trim(), 'a X c');
  });

  it('appends to array with +=', async () => {
    const { stdout } = await runShell('arr=(a b)\narr+=(c d)\necho ${arr[@]}\necho ${#arr[@]}\n');
    assert.strictEqual(stdout.trim(), 'a b c d\n4');
  });
});

describe('multi-line input', () => {
  it('if spanning multiple lines', async () => {
    const { stdout } = await runShell('if true\nthen\necho yes\nfi\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('for spanning multiple lines', async () => {
    const { stdout } = await runShell('for x in a b\ndo\necho $x\ndone\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('function spanning multiple lines', async () => {
    const { stdout } = await runShell('f() {\necho hi\n}\nf\n');
    assert.strictEqual(stdout.trim(), 'hi');
  });
});

describe('arithmetic expansion', () => {
  it('evaluates basic arithmetic', async () => {
    const { stdout } = await runShell('echo $((2 + 3))\n');
    assert.strictEqual(stdout.trim(), '5');
  });

  it('respects operator precedence', async () => {
    const { stdout } = await runShell('echo $((2 + 3 * 4))\n');
    assert.strictEqual(stdout.trim(), '14');
  });

  it('supports variables', async () => {
    const { stdout } = await runShell('export x=10\necho $((x + 5))\n');
    assert.strictEqual(stdout.trim(), '15');
  });

  it('supports assignment within expression', async () => {
    const { stdout } = await runShell('echo $((x = 7))\necho $x\n');
    assert.strictEqual(stdout.trim(), '7\n7');
  });

  it('supports comparison operators', async () => {
    const { stdout } = await runShell('echo $((5 > 3))\necho $((2 == 2))\n');
    assert.strictEqual(stdout.trim(), '1\n1');
  });

  it('supports power operator', async () => {
    const { stdout } = await runShell('echo $((2 ** 8))\n');
    assert.strictEqual(stdout.trim(), '256');
  });

  it('supports ternary operator', async () => {
    const { stdout } = await runShell('export x=1\necho $((x ? 42 : 99))\n');
    assert.strictEqual(stdout.trim(), '42');
  });
});
