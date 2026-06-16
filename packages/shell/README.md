# @mithic/shell

A POSIX-style shell interpreter that runs as a regular Mithic process. It is a
plain TypeScript shell — lexer, parser, expander, builtins, and executor — that
reads a script, runs it, and writes to its stdio streams like any other guest.

## Pieces

- `tokenize` / `parse` — lexer and parser producing a `Program` AST.
- `Expander` — variable / word expansion.
- `BUILTINS`, `isBuiltin`, `runBuiltin` — built-in commands (`cd`, `pwd`,
  `export`, `echo`, `printf`, `cat`, `test`/`[`, `true`, `false`, …).
- `Executor` — runs a parsed `Program` against a `KernelClient`, wiring pipelines
  and redirects; builtin pipelines (e.g. `echo hi | cat`) run in-process.
- `runScript(src, { commands })` — boots a real kernel + runtime and runs a
  script end-to-end; `commands` registers external (non-builtin) commands the
  shell can spawn by name.

## Quick start

```ts
import { runScript } from '@mithic/shell';

const { stdout, code } = await runScript('echo hello | cat');
// stdout === 'hello\n', code === 0
```

### Driving the executor directly (e.g. an interactive terminal)

```ts
import { Executor, parse } from '@mithic/shell';

const executor = new Executor(kernelClient, { cwd: '/', env: {} }, {
  onStdout: (s) => term.write(s),
  onStderr: (s) => term.write(s),
});
await executor.run(parse('echo hi | cat'));
```

### External commands

Non-builtin commands fork CHILD processes via the kernel's `process/spawn` /
`process/pipeline` syscalls. Builtins still run in-process (builtin-first
dispatch); only non-builtins spawn. The kernel owns command resolution — the
shell spawns by NAME and the kernel maps it to spawnable guest code (an
unknown name yields ENOENT). Register external commands when booting:

```ts
const { stdout } = await runScript('greet world | upper', {
  commands: { greet: GREET_GUEST_CODE, upper: UPPER_GUEST_CODE },
});
```

> **Still deferred:** `$?` / `$PIPESTATUS`, glob/brace expansion, shell
> functions, job control, and input redirects (`<`, `<<`, fd-dup).
