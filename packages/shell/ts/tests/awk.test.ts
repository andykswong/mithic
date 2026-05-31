import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
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
// Basic output
// =============================================================================

describe('awk: basic output', () => {
  it('prints entire line via $0', async () => {
    const { stdout, exit } = await runShell('echo "hello" | awk \'{print $0}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('prints multiple lines', async () => {
    const { stdout, exit } = await runShell('printf "foo\\nbar\\nbaz\\n" | awk \'{print $0}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'foo\nbar\nbaz');
  });

  it('print without args prints $0', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | awk \'{print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world');
  });
});

// =============================================================================
// Field splitting
// =============================================================================

describe('awk: field splitting', () => {
  it('splits on whitespace by default, prints $2', async () => {
    const { stdout, exit } = await runShell('echo "a b c" | awk \'{print $2}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'b');
  });

  it('prints first field $1', async () => {
    const { stdout, exit } = await runShell('echo "one two three" | awk \'{print $1}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'one');
  });

  it('prints last field via $NF', async () => {
    const { stdout, exit } = await runShell('echo "a b c d" | awk \'{print $NF}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'd');
  });

  it('custom FS with -F:', async () => {
    const { stdout, exit } = await runShell('echo "a:b:c" | awk -F: \'{print $2}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'b');
  });

  it('custom FS comma with -F,', async () => {
    const { stdout, exit } = await runShell('echo "x,y,z" | awk -F, \'{print $3}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'z');
  });

  it('regex field separator', async () => {
    const { stdout, exit } = await runShell('echo "a1b2c3d" | awk -F\'[0-9]\' \'{print $1, $2, $3, $4}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a b c d');
  });

  it('NF gives number of fields', async () => {
    const { stdout, exit } = await runShell('echo "a b c d e" | awk \'{print NF}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '5');
  });
});

// =============================================================================
// BEGIN and END rules
// =============================================================================

describe('awk: BEGIN and END', () => {
  it('BEGIN runs before input', async () => {
    const { stdout, exit } = await runShell('echo "x" | awk \'BEGIN{print "start"} {print} END{print "done"}\'\n');
    assert.strictEqual(exit, 0);
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], 'start');
    assert.strictEqual(lines[1], 'x');
    assert.strictEqual(lines[2], 'done');
  });

  it('BEGIN-only program runs without input', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print "hello"}\'\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('hello'));
  });

  it('END accumulates and prints sum', async () => {
    const { stdout, exit } = await runShell('seq 1 10 | awk \'{sum+=$1} END{print sum}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '55');
  });
});

// =============================================================================
// NR and NF built-in variables
// =============================================================================

describe('awk: NR and NF', () => {
  it('NR is the record number', async () => {
    const { stdout, exit } = await runShell('printf "a b\\nc d e\\n" | awk \'{print NR, NF}\'\n');
    assert.strictEqual(exit, 0);
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], '1 2');
    assert.strictEqual(lines[1], '2 3');
  });

  it('NR at END is total line count', async () => {
    const { stdout, exit } = await runShell('printf "x\\ny\\nz\\n" | awk \'END{print NR}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3');
  });
});

// =============================================================================
// Arithmetic
// =============================================================================

describe('awk: arithmetic', () => {
  it('addition in BEGIN', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print 2+3*4}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '14');
  });

  it('modulo operator', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print 17%5}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2');
  });

  it('exponentiation with ^', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print 2^10}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1024');
  });

  it('floating point division', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%.2f\\n", 10/3}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3.33');
  });

  it('math functions: sqrt', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%.4f\\n", sqrt(2)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1.4142');
  });

  it('math functions: int truncates toward zero', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print int(3.9), int(-3.9)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3 -3');
  });
});

// =============================================================================
// Variables
// =============================================================================

describe('awk: variables', () => {
  it('-v assigns variable before execution', async () => {
    const { stdout, exit } = await runShell('echo "" | awk -v x=hello \'BEGIN{print x}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('-v with numeric value', async () => {
    const { stdout, exit } = await runShell('echo "" | awk -v n=42 \'BEGIN{print n*2}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '84');
  });

  it('user-defined variable accumulates across records', async () => {
    const { stdout, exit } = await runShell('printf "1\\n2\\n3\\n" | awk \'{s+=$1} END{print s}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '6');
  });
});

// =============================================================================
// Pattern matching
// =============================================================================

describe('awk: pattern matching', () => {
  it('regex pattern /ba/ matches lines containing "ba"', async () => {
    const { stdout, exit } = await runShell('printf "foo\\nbar\\nbaz\\n" | awk \'/ba/\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'bar\nbaz');
  });

  it('regex match operator ~ matches field', async () => {
    const { stdout, exit } = await runShell('printf "apple\\nbanana\\ncherry\\n" | awk \'$0 ~ /an/\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'banana');
  });

  it('negated match operator !~ excludes matches', async () => {
    const { stdout, exit } = await runShell('printf "apple\\nbanana\\ncherry\\n" | awk \'$0 !~ /an/\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'apple\ncherry');
  });

  it('string comparison pattern', async () => {
    const { stdout, exit } = await runShell('printf "banana\\napple\\ncherry\\n" | awk \'$1 > "b"\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'banana\ncherry');
  });
});

// =============================================================================
// If / else
// =============================================================================

describe('awk: if/else', () => {
  it('if/else based on field value', async () => {
    const { stdout, exit } = await runShell('echo "5" | awk \'{if($1>3) print "big"; else print "small"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'big');
  });

  it('else branch taken when condition false', async () => {
    const { stdout, exit } = await runShell('echo "1" | awk \'{if($1>3) print "big"; else print "small"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'small');
  });

  it('ternary operator', async () => {
    const { stdout, exit } = await runShell('printf "1\\n2\\n3\\n" | awk \'{print ($1%2==0 ? "even" : "odd")}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'odd\neven\nodd');
  });
});

// =============================================================================
// Loops
// =============================================================================

describe('awk: loops', () => {
  it('for loop iterates from 1 to 5', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{for(i=1;i<=5;i++) printf "%d ",i; print ""}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1 2 3 4 5');
  });

  it('while loop', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{i=1; while(i<=3){print i; i++}}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });

  it('do-while loop', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{i=0; do{i++; print i}while(i<3)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });
});

// =============================================================================
// Arrays
// =============================================================================

describe('awk: arrays', () => {
  it('numeric-indexed array access', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a[1]="x"; a[2]="y"; print a[1], a[2]}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'x y');
  });

  it('string-keyed associative array', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a["x"]=1; a["y"]=2; print a["x"]+a["y"]}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3');
  });

  it('for-in iterates over array (sorted output)', async () => {
    const { stdout, exit } = await runShell(
      'printf "a\\nb\\na\\nc\\nb\\na\\n" | awk \'{count[$1]++} END{for(k in count) print k, count[k]}\' | sort\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a 3\nb 2\nc 1');
  });

  it('delete removes array element', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a[1]=1; a[2]=2; delete a[1]; for(k in a) print k, a[k]}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2 2');
  });

  it('in operator tests array membership', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a["hello"]=1; if("hello" in a) print "yes"; else print "no"}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'yes');
  });
});

// =============================================================================
// String functions
// =============================================================================

describe('awk: string functions', () => {
  it('length, substr, index', async () => {
    const { stdout, exit } = await runShell('echo "Hello World" | awk \'{print length($0), substr($0,7), index($0,"World")}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '11 World 7');
  });

  it('gsub replaces all occurrences', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | awk \'{gsub(/o/,"0"); print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hell0 w0rld');
  });

  it('sub replaces first occurrence only', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | awk \'{sub(/o/,"0"); print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hell0 world');
  });

  it('split splits string into array', async () => {
    const { stdout, exit } = await runShell('echo "a:b:c" | awk \'{n=split($0,arr,":"); print arr[1], arr[2], arr[3]}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('tolower converts to lowercase', async () => {
    const { stdout, exit } = await runShell('echo "Hello World" | awk \'{print tolower($0)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('toupper converts to uppercase', async () => {
    const { stdout, exit } = await runShell('echo "Hello World" | awk \'{print toupper($0)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'HELLO WORLD');
  });

  it('match sets RSTART and RLENGTH', async () => {
    const { stdout, exit } = await runShell('echo "the year 2024" | awk \'{match($0, /[0-9]+/); print RSTART, RLENGTH}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10 4');
  });

  it('sprintf formats a string', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{s=sprintf("%03d-%s", 7, "ok"); print s}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '007-ok');
  });

  it('string concatenation', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a="hello"; b=" world"; print a b}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world');
  });
});

// =============================================================================
// printf formatting
// =============================================================================

describe('awk: printf formatting', () => {
  it('printf with %d, %f, %s formats', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%05d %8.2f %-10s\\n", 42, 3.14, "hi"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '00042     3.14 hi');
  });

  it('printf %x hex format', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%x\\n", 255}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'ff');
  });

  it('printf %o octal format', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%o\\n", 8}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10');
  });

  it('printf %e scientific notation', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{printf "%.2e\\n", 12345.678}\'\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().startsWith('1.23e') || stdout.trim().startsWith('1.23E'));
  });
});

// =============================================================================
// User-defined functions
// =============================================================================

describe('awk: user-defined functions', () => {
  it('function definition and call', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'function double(x){return x*2} BEGIN{print double(21)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '42');
  });

  it('recursive function: factorial', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'function fact(n){return n<=1?1:n*fact(n-1)} BEGIN{print fact(5)}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '120');
  });
});

// =============================================================================
// Multiple rules
// =============================================================================

describe('awk: multiple rules', () => {
  it('multiple pattern/action rules applied in order', async () => {
    const { stdout, exit } = await runShell(
      'printf "1\\n2\\n3\\n" | awk \'$1==1{print "one"} $1==2{print "two"} $1==3{print "three"}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'one\ntwo\nthree');
  });

  it('range pattern /START/,/END/', async () => {
    const { stdout, exit } = await runShell(
      'printf "a\\nSTART\\nb\\nc\\nEND\\nd\\n" | awk \'/START/,/END/\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'START\nb\nc\nEND');
  });
});

// =============================================================================
// Output field separator and field assignment
// =============================================================================

describe('awk: OFS and field assignment', () => {
  it('OFS used when printing multiple fields', async () => {
    const { stdout, exit } = await runShell('echo "a b c" | awk \'BEGIN{OFS="-"}{print $1,$2,$3}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a-b-c');
  });

  it('assigning to a field triggers $0 rebuild with OFS', async () => {
    const { stdout, exit } = await runShell('echo "a b c" | awk \'{$2="X"; print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a X c');
  });

  it('ORS changes output record separator', async () => {
    const { stdout, exit } = await runShell('printf "a\\nb\\nc\\n" | awk \'BEGIN{ORS=","}{print $0}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a,b,c,');
  });
});

// =============================================================================
// Control flow: next, exit
// =============================================================================

describe('awk: next and exit', () => {
  it('next skips to next record', async () => {
    const { stdout, exit } = await runShell('printf "1\\n2\\n3\\n" | awk \'{if($1==2) next; print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n3');
  });

  it('exit in BEGIN sets non-zero exit code', async () => {
    const { exit } = await runShell('echo "" | awk \'BEGIN{exit 42}\'\n');
    assert.ok(exit !== 0, 'exit code should be non-zero');
  });

  it('exit stops processing', async () => {
    const { stdout } = await runShell('printf "1\\n2\\n3\\n" | awk \'{if($1==2) exit; print}\'\n');
    assert.strictEqual(stdout.trim(), '1');
  });
});

// =============================================================================
// Increment / decrement
// =============================================================================

describe('awk: increment and decrement', () => {
  it('post-increment returns old value', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{x=5; print x++, x}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '5 6');
  });

  it('pre-increment returns new value', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{x=5; print ++x, x}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '6 6');
  });
});

// =============================================================================
// Pipeline integration
// =============================================================================

describe('awk: pipeline integration', () => {
  it('seq piped through awk to compute sum', async () => {
    const { stdout, exit } = await runShell('seq 1 10 | awk \'{sum+=$1} END{print sum}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '55');
  });

  it('awk output piped to sort', async () => {
    const { stdout, exit } = await runShell(
      'printf "banana\\napple\\ncherry\\n" | awk \'{print $1}\' | sort\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'apple\nbanana\ncherry');
  });

  it('awk in pipeline with grep', async () => {
    const { stdout, exit } = await runShell(
      'printf "foo 1\\nbar 2\\nbaz 3\\n" | grep "bar" | awk \'{print $2}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2');
  });
});

// =============================================================================
// File I/O
// =============================================================================

describe('awk: file I/O', () => {
  it('print to file with >', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "x" | awk \'{print "hello" > "/tmp/awk_write.txt"}\'\ncat /tmp/awk_write.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('append to file with >>', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "x" | awk \'BEGIN{print "line1" > "/tmp/awk_append.txt"; print "line2" >> "/tmp/awk_append.txt"}\'\ncat /tmp/awk_append.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'line1\nline2');
  });

  it('getline reads from file', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "file content" > /tmp/awk_getline.txt\necho "" | awk \'BEGIN{getline line < "/tmp/awk_getline.txt"; print line}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'file content');
  });

  it('getline in loop reads all lines from file', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\nprintf "alpha\\nbeta\\ngamma\\n" > /tmp/awk_getline_loop.txt\n' +
      'echo "" | awk \'BEGIN{while((getline line < "/tmp/awk_getline_loop.txt") > 0) print line}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'alpha\nbeta\ngamma');
  });
});

// =============================================================================
// Multi-file NR/FNR
// =============================================================================

describe('awk: multi-file NR and FNR', () => {
  it('NR increments across files, FNR resets per file', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "a" > /tmp/awk_f1.txt\necho "b" > /tmp/awk_f2.txt\n' +
      'awk \'{print NR, FNR, $0}\' /tmp/awk_f1.txt /tmp/awk_f2.txt\n'
    );
    assert.strictEqual(exit, 0);
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], '1 1 a');
    assert.strictEqual(lines[1], '2 1 b');
  });

  it('FILENAME variable holds current file name', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "x" > /tmp/awk_fname.txt\n' +
      'awk \'{print FILENAME}\' /tmp/awk_fname.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().includes('awk_fname.txt'));
  });
});

// =============================================================================
// Pipe from awk
// =============================================================================

describe('awk: pipe to command', () => {
  it('pipe output prints error message (pipes not supported)', async () => {
    const { stderr } = await runShell(
      'printf "c\\na\\nb\\n" | awk \'{print | "sort"}\'\n'
    );
    assert.ok(stderr.includes('not supported'), 'should report pipes not supported');
  });
});

// =============================================================================
// Miscellaneous
// =============================================================================

describe('awk: miscellaneous', () => {
  it('uninitialized variable is empty string / zero', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print x+0, x""}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '0');
  });

  it('numeric string comparison', async () => {
    const { stdout, exit } = await runShell('printf "9\\n10\\n11\\n" | awk \'$1 > 9\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10\n11');
  });

  it('empty pattern matches every record', async () => {
    const { stdout, exit } = await runShell('printf "x\\ny\\n" | awk \'{count++} END{print count}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2');
  });

  it('RS can be changed to change record separator', async () => {
    const { stdout, exit } = await runShell(
      'printf "a:b:c" | awk \'BEGIN{RS=":"}{print NR, $0}\'\n'
    );
    assert.strictEqual(exit, 0);
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], '1 a');
    assert.strictEqual(lines[1], '2 b');
    assert.ok(lines[2].startsWith('3'));
  });

  it('gsub returns count of substitutions', async () => {
    const { stdout, exit } = await runShell('echo "aabbcc" | awk \'{n=gsub(/a/,"x"); print n, $0}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2 xxbbcc');
  });

  it('split returns number of pieces', async () => {
    const { stdout, exit } = await runShell('echo "a:b:c:d" | awk \'{n=split($0,arr,":"); print n}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('parenthesized > inside print is comparison, not redirect', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print (3 > 2)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1');
  });

  it('unparenthesized > in print is redirect', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho x | awk \'{print "written" > "/tmp/awk_redir_test.txt"}\'\ncat /tmp/awk_redir_test.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'written');
  });

  it('> in if condition is comparison, not redirect', async () => {
    const { stdout, exit } = await runShell('printf "3\\n7\\n1\\n" | awk \'{if ($1 > 5) print $1}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '7');
  });
});

// =============================================================================
// getline variants
// =============================================================================

describe('awk: getline variants', () => {
  it('bare getline advances to next record', async () => {
    const { stdout, exit } = await runShell('printf "line1\\nline2\\nline3\\n" | awk \'{getline; print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'line2\nline3');
  });

  it('getline into variable reads next record without changing $0', async () => {
    const { stdout, exit } = await runShell('printf "a\\nb\\nc\\n" | awk \'{getline x; print $0, x}\'\n');
    assert.strictEqual(exit, 0);
    // Record 1: $0="a", getline x→"b" (consumes next), print "a b"
    // Record 3: $0="c", getline x→EOF (x retains "b"), print "c b"
    assert.strictEqual(stdout.trim(), 'a b\nc b');
  });

  it('close() then re-read restarts file from beginning', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\necho "data" > /tmp/awk_close.txt\n' +
      'echo "" | awk \'BEGIN{getline x < "/tmp/awk_close.txt"; close("/tmp/awk_close.txt"); getline y < "/tmp/awk_close.txt"; print x, y}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'data data');
  });
});

// =============================================================================
// Multi-dimensional arrays
// =============================================================================

describe('awk: multi-dimensional arrays', () => {
  it('multi-dimensional array stores and retrieves values', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a[1,2]="x"; a[3,4]="y"; print a[1,2], a[3,4]}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'x y');
  });

  it('multi-dimensional in operator finds existing key', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a[1,2]="yes"; if ((1,2) in a) print "found"; else print "not found"}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'found');
  });

  it('negative array index works as string key', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a[-1]="neg"; print a[-1]}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'neg');
  });

  it('for-in counts all array keys', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a["x"]=1;a["y"]=2;a["z"]=3; for(k in a) c++; print c}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3');
  });

  it('delete entire array leaves length 0', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a[1]=1;a[2]=2;delete a; print length(a)}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '0');
  });

  it('assignment operators work on array elements', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'BEGIN{a["x"]=10; a["x"]+=5; a["x"]*=2; print a["x"]}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '30');
  });
});

// =============================================================================
// BEGIN-only and pattern-without-action behavior
// =============================================================================

describe('awk: BEGIN-only and pattern behavior', () => {
  it('BEGIN-only program does not hang on stdin', async () => {
    const { stdout, exit } = await runShell('awk \'BEGIN{print "hello"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('empty action block is a no-op (no output)', async () => {
    const { stdout, exit } = await runShell('printf "a\\nb\\nc\\n" | awk \'/b/ { }\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('pattern without action prints matching line', async () => {
    const { stdout, exit } = await runShell('printf "a\\nb\\nc\\n" | awk \'/b/\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'b');
  });

  it('multiple patterns can match the same line', async () => {
    const { stdout, exit } = await runShell('printf "hello\\n" | awk \'/hello/{print "a"} /ell/{print "b"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a\nb');
  });
});

// =============================================================================
// File output: repeated redirect to same file
// =============================================================================

describe('awk: repeated redirect to same file', () => {
  it('repeated > to same filename appends within a run', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\nprintf "1\\n2\\n3\\n" | awk \'{print $0 > "/tmp/awk_repeat.txt"}\'\ncat /tmp/awk_repeat.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });
});

// =============================================================================
// Operators: unary plus, string comparison
// =============================================================================

describe('awk: unary plus and string comparison', () => {
  it('unary plus converts string to number', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{print +5, +"3.14"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '5 3.14');
  });

  it('numeric string literals compare as numbers (POSIX)', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{if ("10" > "9") print "num"; else print "str"}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'num');
  });
});

// =============================================================================
// NF and $0 assignment
// =============================================================================

describe('awk: NF and $0 assignment', () => {
  it('assigning NF to larger value extends fields with empty strings', async () => {
    const { stdout, exit } = await runShell('echo "a b" | awk \'{NF=4; print $3, $4, NF}\'\n');
    assert.strictEqual(exit, 0);
    // $3="" $4="" NF=4, joined with OFS(space): " " + " " + "4" + "\n"
    assert.strictEqual(stdout, '  4\n');
  });

  it('assigning NF to smaller value truncates fields', async () => {
    const { stdout, exit } = await runShell('echo "a b c d" | awk \'{NF=2; print $0}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a b');
  });

  it('assigning $0 re-splits into fields', async () => {
    const { stdout, exit } = await runShell('echo "x" | awk \'{$0="hello world"; print $1, $2, NF}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world 2');
  });
});

// =============================================================================
// Regex FS with split
// =============================================================================

describe('awk: regex FS via FS variable', () => {
  it('regex FS set via FS variable splits correctly', async () => {
    const { stdout, exit } = await runShell('echo "a1b2c3d" | awk \'BEGIN{FS="[0-9]"}{print $1, $2, $3, $4}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a b c d');
  });
});

// =============================================================================
// sub() and gsub() with & replacement
// =============================================================================

describe('awk: sub/gsub replacement with &', () => {
  it('sub() replaces & with matched text', async () => {
    const { stdout, exit } = await runShell('echo "hello world" | awk \'{sub(/o/, "[&]"); print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hell[o] world');
  });

  it('gsub() with literal \\& inserts ampersand character', async () => {
    const { stdout, exit } = await runShell('echo "hello" | awk \'{gsub(/l/, "\\\\&"); print}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'he&&o');
  });
});

// =============================================================================
// OFMT
// =============================================================================

describe('awk: OFMT', () => {
  it('OFMT controls number-to-string conversion when printing', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{OFMT="%.2f"; x=3.14159; print x}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '3.14');
  });
});

// =============================================================================
// do-while loop
// =============================================================================

describe('awk: do-while loop', () => {
  it('do-while executes body at least once', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{i=1; do{print i; i++}while(i<=3)}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });
});

// =============================================================================
// Concatenation
// =============================================================================

describe('awk: concatenation', () => {
  it('adjacent string expressions concatenate', async () => {
    const { stdout, exit } = await runShell('echo "" | awk \'BEGIN{a="hello"; b="world"; print a " " b}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('field concatenation produces no separator', async () => {
    const { stdout, exit } = await runShell('echo "foo bar" | awk \'{print $1 $2}\'\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'foobar');
  });
});

// =============================================================================
// Range pattern across multiple files
// =============================================================================

describe('awk: range pattern across files', () => {
  it('range pattern resets independently for each input file', async () => {
    const { stdout, exit } = await runShell(
      'mkdir -p /tmp\n' +
      'printf "a\\nSTART\\nb\\nEND\\nc\\n" > /tmp/awk_range1.txt\n' +
      'printf "d\\nSTART\\ne\\nEND\\nf\\n" > /tmp/awk_range2.txt\n' +
      'awk \'/START/,/END/\' /tmp/awk_range1.txt /tmp/awk_range2.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'START\nb\nEND\nSTART\ne\nEND');
  });
});

// =============================================================================
// Ternary in printf
// =============================================================================

describe('awk: ternary in printf', () => {
  it('ternary expression used inside printf produces correct output', async () => {
    const { stdout, exit } = await runShell(
      'printf "1\\n2\\n3\\n4\\n5\\n" | awk \'{printf "%s ", ($1%2==0 ? "even" : "odd")}END{print ""}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'odd even odd even odd');
  });
});

// =============================================================================
// Function recursion
// =============================================================================

describe('awk: function recursion', () => {
  it('recursive function computes factorial correctly', async () => {
    const { stdout, exit } = await runShell(
      'echo "" | awk \'function fact(n){if(n<=1)return 1; return n*fact(n-1)} BEGIN{print fact(5)}\'\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '120');
  });
});
