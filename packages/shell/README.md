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
- `runScript(src)` — boots a real kernel + runtime and runs a script end-to-end.

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

> **Known limitation:** spawning EXTERNAL (non-builtin) commands needs a
> `process/spawn` kernel syscall that does not exist yet, so a real shell guest
> can currently only run builtins. The executor's external-spawn path is
> implemented and mock-tested, ready for that syscall.
