import { expect, test, describe } from 'vitest';
import { parseProgram } from './parser.ts';
import { Interpreter } from './interp.ts';
import type { AwkIO, AwkOptions, InputSource } from './interp.ts';

/** Run an awk program over `input` text; return captured stdout. */
function run(prog: string, input = '', opts: AwkOptions = {}, files: Record<string, string> = {}): string {
  let out = '';
  let err = '';
  const written: Record<string, string> = {};
  const io: AwkIO = {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    writeFile: (path, text, append) => { written[path] = (append ? written[path] ?? '' : '') + text; },
    readFile: (path) => files[path],
    runCommand: (cmd) => files['cmd:' + cmd],
  };
  const program = parseProgram(prog);
  const inputs: InputSource[] = input === '' && !prog.includes('FILENAME')
    ? [{ name: '', text: input }]
    : [{ name: 'input', text: input }];
  const interp = new Interpreter(program, io, opts);
  interp.run(input === '' ? [] : inputs);
  // Expose file writes for assertions via a marker.
  (run as unknown as { lastFiles: Record<string, string>; lastErr: string }).lastFiles = written;
  (run as unknown as { lastErr: string }).lastErr = err;
  return out;
}

function runFiles(prog: string, input: string): Record<string, string> {
  run(prog, input);
  return (run as unknown as { lastFiles: Record<string, string> }).lastFiles;
}

describe('awk interp — fields & separators', () => {
  test('print specific field', () => {
    expect(run('{ print $2 }', 'a b c\nd e f\n')).toBe('b\ne\n');
  });

  test('print $0 by default', () => {
    expect(run('{ print }', 'hello\n')).toBe('hello\n');
  });

  test('NF counts fields', () => {
    expect(run('{ print NF }', 'a b c\n')).toBe('3\n');
  });

  test('whitespace FS collapses runs and ignores leading/trailing', () => {
    expect(run('{ print NF, $1, $2 }', '   a    b   \n')).toBe('2 a b\n');
  });

  test('custom single-char FS', () => {
    expect(run('{ print $2 }', 'a:b:c\n', { fs: ':' })).toBe('b\n');
  });

  test('regex FS', () => {
    expect(run('BEGIN{FS="[0-9]+"} { print $2 }', 'a12b34c\n')).toBe('b\n');
  });

  test('field assignment rebuilds $0 with OFS', () => {
    expect(run('{ $2 = "X"; print }', 'a b c\n')).toBe('a X c\n');
  });

  test('OFS applies on rebuild', () => {
    expect(run('BEGIN{OFS="-"} { $1=$1; print }', 'a b c\n')).toBe('a-b-c\n');
  });

  test('assigning beyond NF extends record', () => {
    expect(run('{ $5="e"; print; print NF }', 'a b\n')).toBe('a b   e\n5\n');
  });

  test('setting NF truncates', () => {
    expect(run('{ NF=2; print }', 'a b c d\n')).toBe('a b\n');
  });

  test('$0 reassignment re-splits', () => {
    expect(run('{ $0="x y z"; print NF, $3 }', 'a\n')).toBe('3 z\n');
  });

  test('NR and FNR', () => {
    expect(run('{ print NR }', 'a\nb\nc\n')).toBe('1\n2\n3\n');
  });

  test('ORS changes record terminator', () => {
    expect(run('BEGIN{ORS=";"} { print }', 'a\nb\n')).toBe('a;b;');
  });
});

describe('awk interp — patterns', () => {
  test('regex pattern (implicit print)', () => {
    expect(run('/b/', 'a\nb\nc\nab\n')).toBe('b\nab\n');
  });

  test('expression pattern', () => {
    expect(run('$1 > 2 { print $1 }', '1\n3\n2\n5\n')).toBe('3\n5\n');
  });

  test('BEGIN and END', () => {
    expect(run('BEGIN{print "start"} {print} END{print "end"}', 'x\n'))
      .toBe('start\nx\nend\n');
  });

  test('END sees final NR', () => {
    expect(run('END{print NR}', 'a\nb\nc\n')).toBe('3\n');
  });

  test('range pattern /a/,/c/', () => {
    expect(run('/start/,/end/', 'x\nstart\nm\nend\ny\n')).toBe('start\nm\nend\n');
  });

  test('range single-line (start matches end on same line)', () => {
    expect(run('/a/,/a/', 'a\nb\na\n')).toBe('a\na\n');
  });

  test('negated regex match', () => {
    expect(run('$0 !~ /b/', 'a\nb\nc\n')).toBe('a\nc\n');
  });
});

describe('awk interp — operators & coercion', () => {
  test('arithmetic', () => {
    expect(run('BEGIN{ print 2+3*4 }')).toBe('14\n');
  });

  test('power right assoc', () => {
    expect(run('BEGIN{ print 2^3^2 }')).toBe('512\n');
  });

  test('string concat', () => {
    expect(run('BEGIN{ print "a" "b" 1+1 }')).toBe('ab2\n');
  });

  test('string constant comparison is lexical, not numeric', () => {
    // String constants compare as strings: "10" < "9" lexically.
    expect(run('BEGIN{ if ("10" > "9") print "num"; else print "str" }')).toBe('str\n');
    expect(run('BEGIN{ print ("10" < "9") }')).toBe('1\n');
  });

  test('numeric-string (strnum) fields compare numerically', () => {
    // Fields that look numeric compare as numbers: 10 > 9.
    expect(run('{ if ($1 > $2) print "num"; else print "str" }', '10 9\n')).toBe('num\n');
  });

  test('string comparison for non-numeric', () => {
    expect(run('BEGIN{ if ("apple" < "banana") print "yes" }')).toBe('yes\n');
  });

  test('uninitialized var is 0 and ""', () => {
    expect(run('BEGIN{ print x+0, "[" x "]" }')).toBe('0 []\n');
  });

  test('increment pre and post', () => {
    expect(run('BEGIN{ i=5; print i++, i, ++i }')).toBe('5 6 7\n');
  });

  test('compound assignment', () => {
    expect(run('BEGIN{ x=10; x+=5; x*=2; print x }')).toBe('30\n');
  });

  test('ternary', () => {
    expect(run('BEGIN{ print (1 ? "a" : "b") }')).toBe('a\n');
  });

  test('modulo', () => {
    expect(run('BEGIN{ print 17 % 5 }')).toBe('2\n');
  });

  test('AW1: division by zero warns to stderr, yields 0, and continues (not fatal)', () => {
    // Reference behavior: warn, return 0, keep going (program still exits 0).
    const out = run('BEGIN{ print 1/0; print "after" }');
    expect(out).toBe('0\nafter\n');
    expect((run as unknown as { lastErr: string }).lastErr).toContain('division by zero');
  });

  test('AW1: modulo by zero warns to stderr, yields 0, and continues', () => {
    const out = run('BEGIN{ print 7 % 0; print "ok" }');
    expect(out).toBe('0\nok\n');
    expect((run as unknown as { lastErr: string }).lastErr).toContain('division by zero');
  });

  test('logical operators', () => {
    expect(run('BEGIN{ print (1 && 0), (1 || 0), !0 }')).toBe('0 1 1\n');
  });

  test('integer prints without decimal', () => {
    expect(run('BEGIN{ print 6/2 }')).toBe('3\n');
  });

  test('float uses OFMT-ish formatting', () => {
    expect(run('BEGIN{ print 1/3 }')).toBe('0.333333\n');
  });

  test('large exact integers print in full (no scientific)', () => {
    expect(run('BEGIN{ print 2^54 }')).toBe('18014398509481984\n');
    expect(run('BEGIN{ print 10000000000000000 }')).toBe('10000000000000000\n');
  });
});

describe('awk interp — printf/print parenthesized args (AWK-1)', () => {
  test('printf with parenthesized arg list', () => {
    expect(run('BEGIN{printf("%d %d\\n",1,2)}')).toBe('1 2\n');
  });

  test('print with parenthesized arg list', () => {
    expect(run('BEGIN{print(1,2,3)}')).toBe('1 2 3\n');
  });

  test('print single parenthesized expr unaffected', () => {
    expect(run('BEGIN{print (1+2)}')).toBe('3\n');
  });
});

describe('awk interp — split (AWK-2)', () => {
  test('single-char separator is literal not regex', () => {
    expect(run('BEGIN{ n=split("a.b.c",arr,"."); print n, arr[1], arr[2], arr[3] }'))
      .toBe('3 a b c\n');
  });

  test('multi-char separator is a regex', () => {
    expect(run('BEGIN{ n=split("a12b34c",arr,"[0-9]+"); print n, arr[1], arr[2], arr[3] }'))
      .toBe('3 a b c\n');
  });
});

describe('awk interp — control flow', () => {
  test('if/else', () => {
    expect(run('BEGIN{ if (1) print "t"; else print "f" }')).toBe('t\n');
  });

  test('while loop', () => {
    expect(run('BEGIN{ i=0; while (i<3) { print i; i++ } }')).toBe('0\n1\n2\n');
  });

  test('for loop', () => {
    expect(run('BEGIN{ for(i=0;i<3;i++) print i }')).toBe('0\n1\n2\n');
  });

  test('do-while runs at least once', () => {
    expect(run('BEGIN{ i=5; do print i; while (i<3) }')).toBe('5\n');
  });

  test('break and continue', () => {
    expect(run('BEGIN{ for(i=0;i<5;i++){ if(i==2) continue; if(i==4) break; print i } }'))
      .toBe('0\n1\n3\n');
  });

  test('next skips remaining rules', () => {
    expect(run('NR==2 { next } { print }', 'a\nb\nc\n')).toBe('a\nc\n');
  });

  test('exit with code runs END', () => {
    let code = 0;
    const io: AwkIO = { write: () => {}, writeErr: () => {} };
    const interp = new Interpreter(parseProgram('{ exit 3 } END{ }'), io, {});
    code = interp.run([{ name: '', text: 'a\nb\n' }]);
    expect(code).toBe(3);
  });

  test('exit stops input processing', () => {
    expect(run('{ if (NR==2) exit; print }', 'a\nb\nc\n')).toBe('a\n');
  });
});

describe('awk interp — arrays', () => {
  test('assoc array set/get', () => {
    expect(run('BEGIN{ a["x"]=1; a["y"]=2; print a["x"], a["y"] }')).toBe('1 2\n');
  });

  test('for-in iterates keys', () => {
    expect(run('BEGIN{ a[1]=1; a[2]=1; n=0; for(k in a) n++; print n }')).toBe('2\n');
  });

  test('in operator', () => {
    expect(run('BEGIN{ a["k"]=1; print ("k" in a), ("z" in a) }')).toBe('1 0\n');
  });

  test('delete element', () => {
    expect(run('BEGIN{ a[1]=1; a[2]=2; delete a[1]; print (1 in a), (2 in a) }')).toBe('0 1\n');
  });

  test('delete whole array', () => {
    expect(run('BEGIN{ a[1]=1; a[2]=2; delete a; n=0; for(k in a) n++; print n }')).toBe('0\n');
  });

  test('multidim with SUBSEP', () => {
    expect(run('BEGIN{ a[1,2]=9; print a[1,2], ((1,2) in a) }')).toBe('9 1\n');
  });

  test('counting words', () => {
    expect(run('{ for(i=1;i<=NF;i++) c[$i]++ } END{ print c["a"], c["b"] }', 'a b a\nb a\n'))
      .toBe('3 2\n');
  });
});

describe('awk interp — string builtins', () => {
  test('length', () => {
    expect(run('BEGIN{ print length("hello") }')).toBe('5\n');
  });

  test('length of $0', () => {
    expect(run('{ print length }', 'abcd\n')).toBe('4\n');
  });

  test('length of array', () => {
    expect(run('BEGIN{ a[1]=1; a[2]=1; a[3]=1; print length(a) }')).toBe('3\n');
  });

  // CR2: in a BEGIN block (before any record is read) $0 is the empty string,
  // so `print`, `length`, and length($0) behave like gawk instead of touching
  // `undefined`.
  test('BEGIN: bare print emits an empty line ($0 == "")', () => {
    expect(run('BEGIN{ print }')).toBe('\n');
  });

  test('BEGIN: bare length is 0 (no crash on undefined $0)', () => {
    expect(run('BEGIN{ print length }')).toBe('0\n');
  });

  test('BEGIN: $0 stringifies to empty, not nan', () => {
    expect(run('BEGIN{ print "[" $0 "]" }')).toBe('[]\n');
  });

  test('BEGIN: length($0) == 0 guard works', () => {
    expect(run('BEGIN{ if (length($0) == 0) print "empty" }')).toBe('empty\n');
  });

  test('substr', () => {
    expect(run('BEGIN{ print substr("hello", 2, 3) }')).toBe('ell\n');
  });

  test('substr without length', () => {
    expect(run('BEGIN{ print substr("hello", 3) }')).toBe('llo\n');
  });

  // gawk 5.x: a start position < 1 clamps to 1 WITHOUT reducing the requested
  // length; the length is taken from the clamped start (byte-exact with gawk).
  test('substr negative start does not over-subtract length', () => {
    expect(run('BEGIN{ print substr("hello", -1, 3) }')).toBe('hel\n');
    expect(run('BEGIN{ print substr("hello", 0, 3) }')).toBe('hel\n');
    expect(run('BEGIN{ print substr("hello", -2, 3) }')).toBe('hel\n');
    expect(run('BEGIN{ print substr("hello", -10, 3) }')).toBe('hel\n');
  });

  test('substr negative start with length reaching end', () => {
    expect(run('BEGIN{ print substr("hello", -1, 5) }')).toBe('hello\n');
    expect(run('BEGIN{ print substr("abcdefghij", -5, 20) }')).toBe('abcdefghij\n');
  });

  test('substr negative start no-length starts from 1', () => {
    expect(run('BEGIN{ print substr("hello", -1) }')).toBe('hello\n');
  });

  test('substr non-positive / negative length is empty', () => {
    expect(run('BEGIN{ print "[" substr("hello", 2, -1) "]" }')).toBe('[]\n');
    expect(run('BEGIN{ print "[" substr("hello", 3, 0) "]" }')).toBe('[]\n');
  });

  test('substr truncates fractional start and length', () => {
    expect(run('BEGIN{ print substr("hello", 2.9, 2) }')).toBe('el\n');
    expect(run('BEGIN{ print substr("hello", 1, 2.9) }')).toBe('he\n');
  });

  test('substr start past end is empty', () => {
    expect(run('BEGIN{ print "[" substr("hello", 6) "]" }')).toBe('[]\n');
  });

  test('index', () => {
    expect(run('BEGIN{ print index("hello", "ll") }')).toBe('3\n');
  });

  test('split default FS', () => {
    expect(run('BEGIN{ n=split("a b c", arr); print n, arr[1], arr[3] }')).toBe('3 a c\n');
  });

  test('split with separator', () => {
    expect(run('BEGIN{ n=split("a:b:c", arr, ":"); print n, arr[2] }')).toBe('3 b\n');
  });

  test('sub replaces first', () => {
    expect(run('BEGIN{ s="aaa"; n=sub(/a/, "X", s); print n, s }')).toBe('1 Xaa\n');
  });

  test('gsub replaces all', () => {
    expect(run('BEGIN{ s="aaa"; n=gsub(/a/, "X", s); print n, s }')).toBe('3 XXX\n');
  });

  test('gsub on $0 default target', () => {
    expect(run('{ gsub(/o/, "0"); print }', 'foo boo\n')).toBe('f00 b00\n');
  });

  test('sub with & in replacement', () => {
    expect(run('BEGIN{ s="abc"; sub(/b/, "[&]", s); print s }')).toBe('a[b]c\n');
  });

  test('match sets RSTART and RLENGTH', () => {
    expect(run('BEGIN{ print match("hello", /ll/), RSTART, RLENGTH }')).toBe('3 3 2\n');
  });

  test('match failure', () => {
    expect(run('BEGIN{ print match("hello", /z/), RSTART, RLENGTH }')).toBe('0 0 -1\n');
  });

  test('toupper and tolower', () => {
    expect(run('BEGIN{ print toupper("aB"), tolower("aB") }')).toBe('AB ab\n');
  });

  test('sprintf', () => {
    expect(run('BEGIN{ print sprintf("%05.2f|%s|%d", 3.14159, "hi", 42) }')).toBe('03.14|hi|42\n');
  });
});

describe('awk interp — printf', () => {
  test('printf basic', () => {
    expect(run('BEGIN{ printf "%d-%s\\n", 7, "x" }')).toBe('7-x\n');
  });

  test('printf width and flags', () => {
    expect(run('BEGIN{ printf "[%5d][%-5d][%05d]\\n", 42, 42, 42 }')).toBe('[   42][42   ][00042]\n');
  });

  test('printf hex and octal', () => {
    expect(run('BEGIN{ printf "%x %o %c\\n", 255, 8, 65 }')).toBe('ff 10 A\n');
  });

  test('printf %g', () => {
    expect(run('BEGIN{ printf "%g %g\\n", 100000, 0.0001 }')).toBe('100000 0.0001\n');
  });

  test('printf %e', () => {
    expect(run('BEGIN{ printf "%.2e\\n", 12345 }')).toBe('1.23e+04\n');
  });

  test('printf %% literal', () => {
    expect(run('BEGIN{ printf "100%%\\n" }')).toBe('100%\n');
  });

  test('printf star width', () => {
    expect(run('BEGIN{ printf "%*d\\n", 4, 7 }')).toBe('   7\n');
  });
});

describe('awk interp — user functions', () => {
  test('simple function', () => {
    expect(run('function sq(x){ return x*x } BEGIN{ print sq(5) }')).toBe('25\n');
  });

  test('recursion (factorial)', () => {
    expect(run('function f(n){ return n<=1 ? 1 : n*f(n-1) } BEGIN{ print f(5) }')).toBe('120\n');
  });

  test('extra params are locals', () => {
    expect(run('function g(x,   tmp){ tmp=x*2; return tmp } BEGIN{ tmp=99; print g(3), tmp }'))
      .toBe('6 99\n');
  });

  test('array passed by reference', () => {
    expect(run('function fill(a){ a["k"]=1 } BEGIN{ fill(arr); print arr["k"] }')).toBe('1\n');
  });

  test('mutual recursion', () => {
    expect(run(
      'function iseven(n){ return n==0 ? 1 : isodd(n-1) }' +
      'function isodd(n){ return n==0 ? 0 : iseven(n-1) }' +
      'BEGIN{ print iseven(4), isodd(4) }',
    )).toBe('1 0\n');
  });
});

describe('awk interp — CLI options', () => {
  test('-v assignment', () => {
    expect(run('BEGIN{ print v }', '', { assigns: { v: 'hello' } })).toBe('hello\n');
  });

  test('-v with escape', () => {
    expect(run('BEGIN{ printf "%s", v }', '', { assigns: { v: 'a\\tb' } })).toBe('a\tb');
  });

  test('-F field separator', () => {
    expect(run('{ print $3 }', 'a,b,c\n', { fs: ',' })).toBe('c\n');
  });
});

describe('awk interp — getline & redirect', () => {
  test('plain getline advances NR and $0', () => {
    expect(run('NR==1 { getline; print }', 'a\nb\nc\n')).toBe('b\n');
  });

  test('getline var', () => {
    expect(run('NR==1 { getline x; print x, $0 }', 'a\nb\n')).toBe('b a\n');
  });

  test('getline < file', () => {
    expect(run('BEGIN{ while ((getline line < "f.txt") > 0) print line }', '', {}, { 'f.txt': 'x\ny\n' }))
      .toBe('x\ny\n');
  });

  test('AW2: getline < file does NOT increment NR (POSIX/ref)', () => {
    // Read two lines from a file in the main loop; NR must reflect only the
    // primary input records, not the file-getline reads.
    const out = run(
      '{ getline tmp < "f.txt"; print NR }',
      'a\nb\n',
      {},
      { 'f.txt': 'x\ny\n' },
    );
    // Two primary records → NR is 1 then 2; the file getlines must not bump it.
    expect(out).toBe('1\n2\n');
  });

  test('AW2: getline < file leaves FNR untouched', () => {
    const out = run(
      '{ getline tmp < "f.txt"; print FNR }',
      'a\nb\n',
      {},
      { 'f.txt': 'x\ny\n' },
    );
    expect(out).toBe('1\n2\n');
  });

  test('cmd | getline', () => {
    expect(run('BEGIN{ "echo hi" | getline out; print out }', '', {}, { 'cmd:echo hi': 'hi\n' }))
      .toBe('hi\n');
  });

  test('print > file', () => {
    const files = runFiles('{ print $1 > "out.txt" }', 'a\nb\n');
    expect(files['out.txt']).toBe('a\nb\n');
  });

  test('print >> appends', () => {
    const files = runFiles('BEGIN{ print "x" >> "a.txt"; print "y" >> "a.txt" }', '');
    expect(files['a.txt']).toBe('x\ny\n');
  });
});

describe('awk interp — seeded rand', () => {
  test('rand is deterministic without srand', () => {
    const a = run('BEGIN{ srand(1); print rand() }');
    const b = run('BEGIN{ srand(1); print rand() }');
    expect(a).toBe(b);
    expect(a).not.toBe('0\n');
  });

  test('different seeds give different sequences', () => {
    const a = run('BEGIN{ srand(1); print rand() }');
    const b = run('BEGIN{ srand(2); print rand() }');
    expect(a).not.toBe(b);
  });

  test('rand in [0,1)', () => {
    const v = Number(run('BEGIN{ srand(42); print rand() }').trim());
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
