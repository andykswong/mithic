import { expect, test } from 'vitest';
import { parse } from './parser.ts';

test('parses a two-stage pipeline', () => {
  const ast = parse('echo hi | cat');
  expect(ast.type).toBe('Program');
  const pipe = ast.body[0];
  expect(pipe.type).toBe('Pipeline');
  expect(pipe.stages).toHaveLength(2);
  expect(pipe.stages![0].name).toBe('echo');
});

test('parses output redirect', () => {
  const ast = parse('echo hi > out.txt');
  const cmd = ast.body[0].stages![0];
  expect(cmd.redirects[0]).toMatchObject({ op: '>', target: 'out.txt' });
});

test('each top-level statement records its source line', () => {
  const prog = parse('echo a\nfalse\necho c');
  expect(prog.body[0].line).toBe(1);
  expect(prog.body[1].line).toBe(2);
  expect(prog.body[2].line).toBe(3);
});

test('statements inside a compound body record their source line', () => {
  const prog = parse('if true\nthen\n  echo a\n  echo b\nfi');
  const ifStmt = prog.body[0];
  expect(ifStmt.line).toBe(1);
  expect(ifStmt.then![0].line).toBe(3);
  expect(ifStmt.then![1].line).toBe(4);
});

test('parses variable assignment prefix', () => {
  const ast = parse('FOO=bar echo $FOO');
  expect(ast.body[0].stages![0].assignments[0]).toEqual({ name: 'FOO', value: 'bar' });
});

test('parses if/then/fi', () => {
  const ast = parse('if true; then echo yes; fi');
  expect(ast.body[0].type).toBe('If');
});

test('parses input redirect and fd-dup', () => {
  const r1 = parse('cat < in.txt').body[0].stages![0].redirects[0];
  expect(r1).toMatchObject({ op: '<', target: 'in.txt' });
  const r2 = parse('cmd 2>&1').body[0].stages![0].redirects[0];
  expect(r2).toMatchObject({ op: '>&', fd: 2, target: '1' });
  const r3 = parse('cmd 2> err').body[0].stages![0].redirects[0];
  expect(r3).toMatchObject({ op: '>', fd: 2, target: 'err' });
});

test('<&N parses as an input fd-dup (op "<&", distinct from ">&")', () => {
  const r = parse('read x <&3').body[0].stages![0].redirects[0];
  expect(r).toMatchObject({ op: '<&', target: '3' });
  expect(r.fd).toBeUndefined();
});

test('N<&M parses an input dup on fd N', () => {
  const r = parse('exec 3<&4').body[0].stages![0].redirects[0];
  expect(r).toMatchObject({ op: '<&', fd: 3, target: '4' });
});

test('parses >| clobber-force redirect', () => {
  const r = parse('echo x >| out.txt').body[0].stages![0].redirects[0];
  expect(r).toMatchObject({ op: '>|', target: 'out.txt' });
});

test('parses array literal assignment', () => {
  const a = parse('arr=(a b c)').body[0].stages![0].assignments[0];
  expect(a).toMatchObject({ name: 'arr', array: ['a', 'b', 'c'] });
});

test('parses array append assignment', () => {
  const a = parse('arr+=(d e)').body[0].stages![0].assignments[0];
  expect(a).toMatchObject({ name: 'arr', array: ['d', 'e'], append: true });
});

test('parses array element assignment', () => {
  const a = parse('arr[2]=x').body[0].stages![0].assignments[0];
  expect(a).toMatchObject({ name: 'arr', index: '2', value: 'x' });
});

test('subshell ( ) is still parsed as a subshell, not an array literal', () => {
  const ast = parse('( echo hi )');
  expect(ast.body[0].type).toBe('Subshell');
});

test('parses here-string', () => {
  const r = parse('cat <<< "hello"').body[0].stages![0].redirects[0];
  expect(r.op).toBe('<<<');
});

test('here-string with a single quoted word is NOT mis-extracted as a here-doc', () => {
  // Regression: `<<< "foobar"` once matched the here-doc extractor's `<<DELIM`
  // pattern (delim=foobar), turning it into a `<` + bogus `__HEREDOC__` token.
  const r = parse('grep oo <<< "foobar"').body[0].stages![0].redirects[0];
  expect(r.op).toBe('<<<');
  expect(r.target).toBe('"foobar"');
});

test('parses here-doc body', () => {
  const ast = parse('cat <<EOF\nline1\nline2\nEOF\n');
  const r = ast.body[0].stages![0].redirects[0];
  expect(r.op).toBe('<<');
  expect(r.hereDoc).toBe('line1\nline2\n');
});

test('parses a for loop', () => {
  const ast = parse('for x in a b c; do echo $x; done');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('For');
  expect(stmt.varName).toBe('x');
  expect(stmt.words).toEqual(['a', 'b', 'c']);
});

test('parses an until loop', () => {
  const ast = parse('until false; do echo x; done');
  expect(ast.body[0].type).toBe('While');
  expect(ast.body[0].until).toBe(true);
});

test('parses a case statement', () => {
  const ast = parse('case $x in a) echo A ;; b|c) echo BC ;; *) echo other ;; esac');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Case');
  expect(stmt.clauses).toHaveLength(3);
  expect(stmt.clauses![1].patterns).toEqual(['b', 'c']);
});

test('parses ;& case fallthrough terminator', () => {
  const ast = parse('case a in a) echo one ;& b) echo two ;; esac');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Case');
  expect(stmt.clauses).toHaveLength(2);
  expect(stmt.clauses![0].fallthrough).toBe(true);
  expect(stmt.clauses![1].fallthrough).toBeUndefined();
});

test('parses ;;& case continue-match terminator', () => {
  const ast = parse('case a in a) echo one ;;& b) echo two ;; esac');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Case');
  expect(stmt.clauses).toHaveLength(2);
  expect(stmt.clauses![0].continueMatch).toBe(true);
  expect(stmt.clauses![1].continueMatch).toBeUndefined();
});

test('parses a function definition (name() form)', () => {
  const ast = parse('greet() { echo hi; }');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Function');
  expect(stmt.funcName).toBe('greet');
  expect(stmt.funcBody).toHaveLength(1);
});

test('parses a function definition (function keyword form)', () => {
  const ast = parse('function greet { echo hi; }');
  expect(ast.body[0].type).toBe('Function');
  expect(ast.body[0].funcName).toBe('greet');
});

test('parses arithmetic command (( ))', () => {
  const ast = parse('(( x = 1 + 2 ))');
  expect(ast.body[0].type).toBe('Arithmetic');
  expect(ast.body[0].expr).toContain('x');
});

test('parses [[ conditional ]]', () => {
  const ast = parse('[[ -f foo.txt ]]');
  expect(ast.body[0].type).toBe('Cond');
  expect(ast.body[0].condWords).toEqual(['-f', 'foo.txt']);
});

test('parses background pipeline', () => {
  const ast = parse('sleep 1 &');
  expect(ast.body[0].background).toBe(true);
});

test('parses negated pipeline', () => {
  const ast = parse('! false');
  expect(ast.body[0].negate).toBe(true);
});

test('parses a subshell', () => {
  const ast = parse('( echo hi )');
  expect(ast.body[0].type).toBe('Subshell');
});

// A2: coproc grammar
test('parses unnamed coproc with a compound body', () => {
  const ast = parse('coproc { cat; }');
  expect(ast.body[0].type).toBe('Coproc');
  expect(ast.body[0].coprocName).toBe('COPROC');
  expect(ast.body[0].coprocBody?.type).toBe('Group');
});

test('parses named coproc with a compound body', () => {
  const ast = parse('coproc UP { tr a-z A-Z; }');
  expect(ast.body[0].type).toBe('Coproc');
  expect(ast.body[0].coprocName).toBe('UP');
  expect(ast.body[0].coprocBody?.type).toBe('Group');
});

test('parses unnamed coproc with a simple command (no NAME)', () => {
  // `coproc cat` — `cat` is the command, NOT a name (no compound follows).
  const ast = parse('coproc cat');
  expect(ast.body[0].type).toBe('Coproc');
  expect(ast.body[0].coprocName).toBe('COPROC');
  expect(ast.body[0].coprocBody?.stages?.[0].name).toBe('cat');
});

test('coproc is rejected in POSIX mode', () => {
  expect(() => parse('coproc { cat; }', { posix: true })).toThrow(/coproc/);
});

test('a stray unmatched ]] / )) does not hang the parser (progress guard)', () => {
  // Regression: `echo a[b[c[0]]]` lexes a trailing DRBRACKET (`]]`) that no
  // production consumes; parseProgram used to spin forever (OOM/SIGABRT).
  const cmds = ['echo a[b[c[0]]]', 'echo hi ]]', 'echo x ))', 'echo a; ]]; echo b'];
  for (const c of cmds) {
    const p = parse(c); // must return, not hang
    expect(p.type).toBe('Program');
  }
});

test('stray ]] / )) inside a compound body does not hang (progress guard in all body loops)', () => {
  // Regression: the top-level guard alone left for/if/while/{}/case/subshell/select
  // bodies able to OOM on an unconsumable token. All body loops now guard.
  const cmds = [
    'for x in 1; do echo $x ]]; done',
    'if true; then echo a )); fi',
    'while true; do echo x )); break; done',
    '{ echo a )); }',
    'case x in a) echo A ]];; esac',
    '(echo ]] )',
    'select x in a; do echo )); done',
  ];
  for (const c of cmds) expect(parse(c).type).toBe('Program'); // must return, not hang
});
