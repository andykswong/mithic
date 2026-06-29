import { test } from 'vitest';
import { compareWithBash, compareWithBash4 } from './fixture-runner.ts';

// Bash-comparison golden-fixture suite — shell LANGUAGE parity (builtins,
// parameter expansion, arithmetic, control flow, POSIX mode). No external command
// spawns (the mock kernel stubs spawn/wait), so every case is builtin-only.
//
// Record: `RECORD_FIXTURES=1 npx vitest run packages/shell/src/comparison/shell-behavior.comparison.test.ts`
// Replay (default / CI): `npx vitest run packages/shell/src/comparison/shell-behavior.comparison.test.ts`
//
// The committed fixtures were recorded against macOS /bin/bash 3.2.57. Every case
// below produces IDENTICAL output on bash 3.2 and bash 5.x. See KNOWN_LIMITATIONS.md.

const CASES: Array<[string, string, { posix?: boolean }?]> = [
  ['echo-basic', 'echo hello world'],
  ['param-default', 'x=; echo "${x:-fallback}"'],
  ['param-strip-prefix', 'p=/a/b/c.txt; echo "${p##*/}"'],
  ['param-strip-suffix', 'p=file.tar.gz; echo "${p%.*}"'],
  ['param-replace', 's=aXbXc; echo "${s//X/-}"'],
  ['param-substr', 's=abcdef; echo "${s:1:3}"'],
  ['arith', 'echo $((2 + 3 * 4))'],
  ['for-loop', 'for i in 1 2 3; do echo "n$i"; done'],
  ['brace-expand', 'echo {a,b,c}'],
  ['printf-d', 'printf "%03d\\n" 7'],
];

for (const [name, src, opts] of CASES) {
  test(`bash-parity: ${name}`, async () => {
    await compareWithBash(name, src, opts ?? {});
  });
}

// KNOWN_LIMITATION: bash keeps BRACE EXPANSION enabled in POSIX mode (`--posix`,
// `set -o posix`, POSIXLY_CORRECT=1 all emit `a b c`). mithic SUPPRESSES brace
// expansion in posix mode (emits `{a,b,c}` literal — see posix-mode.test.ts "brace
// expansion disabled in POSIX mode"), matching a true POSIX `sh` (dash) rather than
// bash's posix mode. This is a deliberate divergence: mithic is stricter than bash
// here. The fixture below is the correct bash golden (`a b c`); the case is skipped
// because mithic intentionally does not match it. See KNOWN_LIMITATIONS.md.
test.skip('bash-parity: brace-suppressed-posix (mithic is stricter than bash)', async () => {
  await compareWithBash('brace-suppressed-posix', 'echo {a,b,c}', { posix: true });
});

// bash-4+ cases (case modification etc.). Their fixtures are hand-recorded from
// bash-5 output because the local bash is 3.2 (where `${s^^}` is a "bad
// substitution"). mithic DOES implement these — replay asserts mithic matches the
// bash-5 golden. Re-record on a bash-4+ host with RECORD_FIXTURES=1 RECORD_BASH4=1.
const BASH4_CASES: Array<[string, string, { posix?: boolean }?]> = [
  ['case-upper', 's=hello; echo "${s^^}"'],
];

for (const [name, src, opts] of BASH4_CASES) {
  test(`bash-parity (bash4+): ${name}`, async () => {
    await compareWithBash4(name, src, opts ?? {});
  });
}
