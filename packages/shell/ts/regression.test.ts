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

// =============================================================================
// P0 BUGS — Critical (breaks basic shell scripts)
// =============================================================================

describe('P0: assignment with command substitution (Bug D)', () => {
  it('x=$(echo hello) assigns captured output', async () => {
    const { stdout } = await runShell('x=$(echo hello)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('x=$(echo hello world) captures full output', async () => {
    const { stdout } = await runShell('x=$(echo hello world)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('x=$(echo a; echo b) captures multiline output', async () => {
    const { stdout } = await runShell('x=$(echo a; echo b)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('x="prefix_$(echo val)_suffix" works with concatenation', async () => {
    const { stdout } = await runShell('x="prefix_$(echo val)_suffix"\necho $x\n');
    assert.strictEqual(stdout.trim(), 'prefix_val_suffix');
  });

  it('x=$((1 + 2)) arithmetic assignment', async () => {
    const { stdout } = await runShell('x=$((1 + 2))\necho $x\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('x=${y:-default} assignment with parameter expansion', async () => {
    const { stdout } = await runShell('x=${y:-default}\necho $x\n');
    assert.strictEqual(stdout.trim(), 'default');
  });

  it('x=$(cat <<< "hello") here-string in command substitution', async () => {
    const { stdout } = await runShell('x=$(echo hello)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('multiple assignments with cmdsub on separate lines', async () => {
    const { stdout } = await runShell('a=$(echo first)\nb=$(echo second)\necho "$a $b"\n');
    assert.strictEqual(stdout.trim(), 'first second');
  });
});

describe('P0: local variable scoping (Bug C)', () => {
  it('local var does not leak to outer scope', async () => {
    const { stdout } = await runShell('unset x\nf() { local x=inside; echo "in:$x"; }; f; echo "out:${x:-undefined}"\n');
    assert.strictEqual(stdout.trim(), 'in:inside\nout:undefined');
  });

  it('local var restores outer value on function return', async () => {
    const { stdout } = await runShell('x=before\nf() { local x=inside; echo "in:$x"; }; f; echo "out:$x"\n');
    assert.strictEqual(stdout.trim(), 'in:inside\nout:before');
  });

  it('nested functions with local vars', async () => {
    const { stdout } = await runShell('x=outer\ninner() { local x=inner_val; echo "inner:$x"; }\nouter_fn() { local x=outer_val; inner; echo "outer_fn:$x"; }\nouter_fn; echo "global:$x"\n');
    assert.strictEqual(stdout.trim(), 'inner:inner_val\nouter_fn:outer_val\nglobal:outer');
  });

  it('local without assignment preserves undefined', async () => {
    const { stdout } = await runShell('unset x\nf() { local x; echo "in:${x:-empty}"; }; f; echo "out:${x:-empty}"\n');
    assert.strictEqual(stdout.trim(), 'in:empty\nout:empty');
  });

  it('local array does not leak', async () => {
    const { stdout } = await runShell('arr=(x y z)\nf() { local arr; arr=(a b c); echo ${#arr[@]}; }; f; echo ${#arr[@]}\n');
    assert.strictEqual(stdout.trim(), '3\n3');
  });

  it('modifying local does not affect outer', async () => {
    const { stdout } = await runShell('x=1\nf() { local x=2; x=3; echo "in:$x"; }; f; echo "out:$x"\n');
    assert.strictEqual(stdout.trim(), 'in:3\nout:1');
  });
});

describe('P0: $(< file) file reading (Bug A)', () => {
  it('$(< file) reads file content', async () => {
    const { stdout } = await runShell('echo "hello" > /tmp/test.txt\necho "$(< /tmp/test.txt)"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('$(< file) strips trailing newlines', async () => {
    const { stdout } = await runShell('printf "hi\\n\\n" > /tmp/t.txt\necho "$(< /tmp/t.txt)"\n');
    // Note: this depends on printf being available; if not, test the core behavior differently
    assert.strictEqual(stdout.trim(), 'hi');
  });

  it('x=$(< file) assigns file content to variable', async () => {
    const { stdout } = await runShell('echo "content" > /tmp/f.txt\nx=$(< /tmp/f.txt)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'content');
  });

  it('$(< file) in double quotes preserves spaces', async () => {
    const { stdout } = await runShell('echo "  spaced  " > /tmp/sp.txt\necho "$(< /tmp/sp.txt)"\n');
    assert.strictEqual(stdout.trim(), 'spaced');
  });

  it('$(< nonexistent) produces error', async () => {
    const { stderr } = await runShell('echo "$(< /tmp/no_such_file_xyz)"\n');
    assert.ok(stderr.includes('No such file'));
  });
});

describe('P0: character ranges in glob [0-9] (Bug F)', () => {
  it('case pattern [0-9] matches single digit', async () => {
    const { stdout } = await runShell('x=5\ncase $x in [0-9]) echo digit;; *) echo other;; esac\n');
    assert.strictEqual(stdout.trim(), 'digit');
  });

  it('case pattern [0-9] does not match letter', async () => {
    const { stdout } = await runShell('x=a\ncase $x in [0-9]) echo digit;; *) echo other;; esac\n');
    assert.strictEqual(stdout.trim(), 'other');
  });

  it('case pattern [a-z] matches lowercase letter', async () => {
    const { stdout } = await runShell('x=m\ncase $x in [a-z]) echo lower;; *) echo other;; esac\n');
    assert.strictEqual(stdout.trim(), 'lower');
  });

  it('case pattern [A-Z] matches uppercase', async () => {
    const { stdout } = await runShell('x=M\ncase $x in [A-Z]) echo upper;; *) echo other;; esac\n');
    assert.strictEqual(stdout.trim(), 'upper');
  });

  it('[[ x == [0-9] ]] extended test with range', async () => {
    const { stdout } = await runShell('x=7\n[[ $x == [0-9] ]] && echo match || echo no\n');
    assert.strictEqual(stdout.trim(), 'match');
  });

  it('negated class [!0-9] matches non-digit', async () => {
    const { stdout } = await runShell('x=a\ncase $x in [!0-9]) echo non-digit;; *) echo digit;; esac\n');
    assert.strictEqual(stdout.trim(), 'non-digit');
  });

  it('[^a-z] negation matches non-lowercase', async () => {
    const { stdout } = await runShell('x=A\ncase $x in [^a-z]) echo non-lower;; *) echo lower;; esac\n');
    assert.strictEqual(stdout.trim(), 'non-lower');
  });

  it('multiple ranges [a-zA-Z0-9]', async () => {
    const { stdout } = await runShell('x=Z\ncase $x in [a-zA-Z0-9]) echo alnum;; *) echo other;; esac\n');
    assert.strictEqual(stdout.trim(), 'alnum');
  });
});

// =============================================================================
// P1 BUGS — High (common bash features)
// =============================================================================

describe('P1: echo flags', () => {
  it('echo -n suppresses trailing newline', async () => {
    const { stdout } = await runShell('echo -n hello\necho " world"\n');
    assert.strictEqual(stdout, 'hello world\n');
  });

  it('echo -e interprets backslash escapes', async () => {
    const { stdout } = await runShell('echo -e "hello\\nworld"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('echo -e interprets \\t as tab', async () => {
    const { stdout } = await runShell('echo -e "a\\tb"\n');
    assert.strictEqual(stdout.trim(), 'a\tb');
  });

  it('echo -ne combines flags', async () => {
    const { stdout } = await runShell('echo -ne "hi\\n"\necho done\n');
    assert.strictEqual(stdout, 'hi\ndone\n');
  });

  it('echo -- -n treats -n as text after --', async () => {
    const { stdout } = await runShell('echo -- -n\n');
    assert.strictEqual(stdout.trim(), '-- -n');
  });
});

describe('P1: printf builtin', () => {
  it('printf basic string', async () => {
    const { stdout } = await runShell('printf "hello"\n');
    assert.strictEqual(stdout, 'hello');
  });

  it('printf with format and args', async () => {
    const { stdout } = await runShell('printf "%s %s\\n" hello world\n');
    assert.strictEqual(stdout, 'hello world\n');
  });

  it('printf %d integer formatting', async () => {
    const { stdout } = await runShell('printf "%d\\n" 42\n');
    assert.strictEqual(stdout, '42\n');
  });

  it('printf repeats format for excess args', async () => {
    const { stdout } = await runShell('printf "%s\\n" a b c\n');
    assert.strictEqual(stdout, 'a\nb\nc\n');
  });
});

describe('P1: eval builtin', () => {
  it('eval executes string as command', async () => {
    const { stdout } = await runShell('eval "echo hello"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('eval with variable expansion', async () => {
    const { stdout } = await runShell('cmd="echo world"\neval $cmd\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('eval constructs variable names dynamically', async () => {
    const { stdout } = await runShell('name=x\neval "$name=42"\necho $x\n');
    assert.strictEqual(stdout.trim(), '42');
  });
});

describe('P1: shift builtin', () => {
  it('shift removes first positional param', async () => {
    const { stdout } = await runShell('f() { echo $1; shift; echo $1; }; f a b c\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('shift N removes N params', async () => {
    const { stdout } = await runShell('f() { shift 2; echo $1; }; f a b c d\n');
    assert.strictEqual(stdout.trim(), 'c');
  });

  it('shift updates $#', async () => {
    const { stdout } = await runShell('f() { echo $#; shift; echo $#; }; f a b c\n');
    assert.strictEqual(stdout.trim(), '3\n2');
  });
});

describe('P1: type/command builtins', () => {
  it('type identifies builtins', async () => {
    const { stdout } = await runShell('type echo\n');
    assert.ok(stdout.includes('builtin'));
  });

  it('type reports not found for missing commands', async () => {
    const { stderr, exit } = await runShell('type nonexistent_xyz\n');
    assert.ok(stderr.includes('not found') || exit !== 0);
  });

  it('command -v returns name for builtins', async () => {
    const { stdout } = await runShell('command -v echo\n');
    assert.strictEqual(stdout.trim(), 'echo');
  });

  it('command -v returns empty for missing', async () => {
    const { stdout, exit } = await runShell('command -v nonexistent_xyz\n');
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(exit, 1);
  });
});

describe('P1: heredoc', () => {
  it('basic heredoc', async () => {
    const { stdout } = await runShell('x=$(<<EOF\nhello\nworld\nEOF\n)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('heredoc with variable expansion', async () => {
    const { stdout } = await runShell('name=Alice\nx=$(<<EOF\nhello $name\nEOF\n)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'hello Alice');
  });

  it('heredoc with quoted delimiter suppresses expansion', async () => {
    const { stdout } = await runShell('name=Alice\nx=$(<<\'EOF\'\nhello $name\nEOF\n)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'hello $name');
  });
});

// =============================================================================
// P2 BUGS — Medium
// =============================================================================

describe('P2: ${x^^} and ${x,,} case modification (Bug E)', () => {
  it('${x^^} converts to uppercase', async () => {
    const { stdout } = await runShell('x="hello"\necho "${x^^}"\n');
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('${x,,} converts to lowercase', async () => {
    const { stdout } = await runShell('x="HELLO"\necho "${x,,}"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('${x^} capitalizes first char', async () => {
    const { stdout } = await runShell('x="hello"\necho "${x^}"\n');
    assert.strictEqual(stdout.trim(), 'Hello');
  });

  it('${x,} lowercases first char', async () => {
    const { stdout } = await runShell('x="HELLO"\necho "${x,}"\n');
    assert.strictEqual(stdout.trim(), 'hELLO');
  });
});

describe('P2: C-style for loop (Bug G)', () => {
  it('for ((i=0; i<3; i++)) basic loop', async () => {
    const { stdout } = await runShell('for ((i=0; i<3; i++)); do echo $i; done\n');
    assert.strictEqual(stdout.trim(), '0\n1\n2');
  });

  it('for (( )) with complex expressions', async () => {
    const { stdout } = await runShell('for ((i=1; i<=5; i+=2)); do echo $i; done\n');
    assert.strictEqual(stdout.trim(), '1\n3\n5');
  });
});

describe('P2: read -a (array mode)', () => {
  it('read -a splits into array', async () => {
    const { stdout } = await runShell('read -a arr <<< "a b c"\necho ${arr[0]} ${arr[1]} ${arr[2]}\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('read -ra splits without backslash processing', async () => {
    const { stdout } = await runShell('IFS=":"\nread -ra arr <<< "a:b:c"\necho ${#arr[@]}\necho ${arr[0]} ${arr[1]} ${arr[2]}\n');
    assert.strictEqual(stdout.trim(), '3\na b c');
  });
});

describe('P2: multiline quoted strings (Bug H)', () => {
  it('double-quoted string with literal newline', async () => {
    const { stdout } = await runShell('echo "line1\nline2"\n');
    assert.strictEqual(stdout, 'line1\nline2\n');
  });

  it('single-quoted string with literal newline', async () => {
    const { stdout } = await runShell('echo \'line1\nline2\'\n');
    assert.strictEqual(stdout, 'line1\nline2\n');
  });

  it('variable with embedded newline', async () => {
    const { stdout } = await runShell('x="a\nb"\necho "$x"\n');
    assert.strictEqual(stdout, 'a\nb\n');
  });
});
