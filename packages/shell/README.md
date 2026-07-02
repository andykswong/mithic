# @mithic/shell

A POSIX-style shell interpreter, written in TypeScript, that runs as a regular
Mithic process. It lexes, parses, expands, and executes shell scripts entirely
in-sandbox: builtins run in-process, and every external command is a CHILD
process the shell forks through the kernel's `process/spawn` / `process/pipeline`
syscalls. The shell never enumerates the command namespace itself — the kernel
owns it (see [External commands](#external-commands)).

> This replaces the earlier Rust→WASM shell. `@mithic/shell` is pure TypeScript
> and ships as a guest module (`dist/process.js`) launched like any other Mithic
> process.

## Architecture

The interpreter is a four-stage pipeline plus an in-process builtin table:

```
source ─▶ lexer ─▶ parser ─▶ expander ─▶ executor
         tokenize   parse     Expander    Executor
```

- **Lexer** (`lexer.ts`, `tokenize`) — splits a line into operator tokens and
  `WORD` tokens. A `WORD` keeps both `value` (quote delimiters removed) and `raw`
  (original text, quotes intact) so the expander can apply quote semantics.
  `$(…)`, `$((…))`, `${…}`, and `` `…` `` are copied verbatim within a word; the
  standalone `((`/`))` and `[[`/`]]` operators are recognised only when not part
  of a `$((` substitution. `#` at a word boundary starts a comment.
- **Parser** (`parser.ts`, `parse`) — builds a `Program` of `Statement`s. The
  grammar covers pipelines of simple commands (with redirects and assignment
  prefixes) joined by `;`, `&&`, `||`, plus compound commands.
- **Expander** (`expander.ts`, `Expander`) — performs word expansion in bash
  order (below). It is async because command substitution runs a subcommand and
  glob lists the VFS. Decoupled from the executor via the `ShellEnv` interface so
  it is unit-testable with a plain mock.
- **Executor** (`executor.ts`, `Executor`) — walks the AST, implements control
  flow, redirects, job control, and `set` options, and implements `ShellEnv` for
  the expander. Builtin-first dispatch: a builtin runs in-process; anything else
  is spawned.
- **Builtins** (`builtins.ts`, `BUILTINS` / `runBuiltin`) — commands that mutate
  shell state (cwd, env, functions, jobs) or write to the current stdout/stderr
  without forking.

`arith.ts` provides the `(( ))` / `$(( ))` integer evaluator; `ast.ts` defines
the node types; `kernel-client.ts` defines the narrow `KernelClient` / `FsClient`
slice the executor depends on; `process.ts` is the guest entry module.

## Expansion

`Expander.expandWord` applies the bash expansion order:

1. **Brace expansion** — `{a,b}`, numeric/alpha ranges `{1..5}`, `{a..e}`,
   `{1..10..2}`, and nesting. Purely textual and happens *before* substitution.
2. **Tilde** / **parameter, command, and arithmetic substitution** —
   `$VAR`, `${VAR}`, `$(cmd)`, `` `cmd` ``, `$(( expr ))`.
3. **Word splitting** on `IFS` (unquoted regions only).
4. **Pathname (glob) expansion** — `*`, `?`, `[…]` character classes, matched
   against the VFS via `ShellEnv.listDir`; an unmatched pattern stays literal.
5. **Quote removal.**

Parameter expansion supports the default/alternate/assign/error forms
(`${v:-w}` `${v:=w}` `${v:?w}` `${v:+w}` and their unset-only `${v-w}` … variants),
prefix/suffix strip (`${v#pat}` `${v##pat}` `${v%pat}` `${v%%pat}`), pattern
substitution (`${v/pat/repl}` `${v//pat/repl}` with `#`/`%` anchors), substring
(`${v:off:len}`), length (`${#v}`), indirection (`${!v}`), indexed arrays
(`${arr[i]}`, `${arr[@]}`, `${arr[*]}`, `${#arr[@]}`, `${!arr[@]}`), and the
`$@`/`$*` positional forms with correct field-boundary semantics under quoting.
Special parameters: `?`, `#`, `@`, `*`, `$`, `!`, `0`, `-` (current option
flags), `PIPESTATUS`, and positionals. With `set -u` (nounset) active, expanding
an unset variable throws `ExpansionError`, which the executor reports to stderr
and aborts the script with a nonzero status.

## Feature set (as implemented)

**Pipelines** — `cmd1 | cmd2 | …`, with leading `!` negation. A pipeline made
entirely of builtins/functions runs in-process, threading each stage's output to
the next as stdin; otherwise the stages are spawned as a single
`process/pipeline` syscall (zero-hop pipes) and the last stage's stdout is
captured back to the shell.

**Lists & conditionals** — `;`, `&&`, `||`.

**Control flow** — `if`/`elif`/`else`, `while`, `until`, `for` (word-list and
`$@` forms), `case`, function definitions and calls, subshells `( … )` (env/cwd
mutations isolated by snapshot+restore), groups `{ … }`, arithmetic commands
`(( … ))`, and `[[ … ]]` conditionals (supports `!`, `&&`, `||`, `=~` regex,
`==`/`=`/`!=` glob match, `-z`/`-n`, `-e`/`-f`/`-d` file tests, and numeric/string
comparisons). `break`, `continue`, `return`, and `exit` unwind via exceptions;
multi-level `break N` / `continue N` are honored.

**Redirects** — `>`, `>>`, `>|` (force past noclobber), `<`, `<<` (here-doc,
with quoted-delimiter expansion suppression), `<<<` (here-string), `<>` (open a
fd for read+write, e.g. `exec 3<>/dev/tcp/host/port`), `>&` fd dup/merge (e.g.
`2>&1`, `>&2`), `<&` **input** fd-dup (e.g. `read <&3`, `<&-` to close), `&>`
(both stdout+stderr), and `&>>` (append both). Leading fd digits (`2>`, `1>>`)
are parsed. `/dev/null`, `/dev/stdout`, and `/dev/stderr` are handled specially;
file targets go through the injected `FsClient` (so redirects require a `vfs`
capability). `/dev/tcp/host/port` and `/dev/udp/host/port` open live sockets via
`<>` (TCP is line/stream-oriented; a `/dev/udp` fd reads one datagram per read).
Redirects can attach to compound commands (`while …; done > f`). For an external
command, `<` / `<<` / `<<<` (and an inherited piped stdin) are **pipe-fed into fd
0 by the kernel** — a `<` becomes a kernel-side `open` of the path streamed into
fd 0 (binary-safe via `FsClient.fsReadBytes` on the in-shell path), a `<<`/`<<<`
body becomes a `bytes` feed — rather than being read into an inline blob.

**I/O model** — the per-command frame's `stdin` is a `ReadableStream<Uint8Array>`
and its stdout/stderr are an `OutputSink` (callable string sink + `writeBytes`
for raw bytes). `cat`/`read`/`mapfile` consume the stream incrementally (one
shared cursor per frame), and a guest's binary stdout reaches the terminal
byte-exact (no UTF-8 round-trip). In-process **compound** pipelines run their
stages concurrently over identity `TransformStream`s (byte-exact, EPIPE on early
exit); an in-process builtin infinite producer (`while :; do echo x; done | head`)
is stopped by a broken-pipe backstop (exit 141).

**Assignments** — scalar `name=v`, append `name+=v`, indexed-array literals
`name=(a b c)` (and `name+=(…)`), and element `name[i]=v` (and `name[i]+=v`).
A command prefix (`FOO=bar cmd`) becomes a temporary env overlay for that
command only.

**Glob** — `*`, `?`, `[…]` (with `!`/`^` negation), descending the VFS;
dotfiles are excluded unless the pattern begins with `.`.

**Functions** — definition + call with positional-parameter rebinding and
`local`/`declare` scoping (save/restore on entry/exit).

**Job control** — `&` backgrounding with a job table, and the `jobs`/`fg`/`bg`/
`wait` builtins. The background pipeline runs detached and records its exit code
on the job. Signal-based suspension (SIGSTOP/SIGCONT) is **not** available in this
runtime: `bg` is a no-op acknowledgement, `fg` waits for the job, and `kill`
reports that signal delivery is unsupported.

**POSIX `set` options** — `errexit` (`-e`), `nounset` (`-u`), `xtrace` (`-x`),
`pipefail`, and `noclobber` (`-C`); toggled via `set -e`/`+e`, `set -o NAME`/
`+o NAME`, or short-flag clusters (`set -eux`). `set --` / `set a b c` replace
the positional parameters. `noclobber` makes a plain `>` refuse to overwrite an
existing regular file (use `>|` to force); `pipefail` makes a pipeline's status
the last non-zero stage's code.

### Builtins

`BUILTINS` (49 entries), all run in-process:

```
cd, pwd, export, unset, echo, printf, test, [, true, false, exit, eval,
set, cat, :, local, declare, readonly, let, shift, return, getopts, read,
mapfile, readarray, jobs, fg, bg, wait, kill, break, continue, source, .,
type, shopt, trap, disown, history, fc, exec, coproc, dirs, pushd, popd,
hash, compgen, complete, compopt
```

`coproc` runs a background co-process with a duplex stdio pair (`COPROC`/
`COPROC_PID`); on relay backends (quickjs/ivm) it is wired via the kernel's
`process/coproc` syscall.

`printf` is a near-complete GNU/bash implementation (`%s %b %c %d %i %u %o %x %X
%f %e %E %g %G %%`, flags, width/precision including `*`, format recycling, and
escape interpretation). `cat` as a builtin only echoes stdin — with file operands
the executor falls through to the external coreutils `cat` so file arguments are
honored. `source`/`.` evaluate their arguments as an inline script (no file read
in the builtin itself). `[` requires a closing `]`.

## External commands

Builtins aside, every command word is resolved and spawned by the **kernel**, not
the shell. The executor's `CommandResolver` simply passes the bare name through;
the guest's `KernelClient` issues a `process/pipeline` syscall with that name as
the stage `path`, and the kernel's `resolveCommand(name, cwd, env)` maps it to
spawnable guest code (or returns `ENOENT`, surfaced as exit `127` with a
`command not found` line on stderr). This is how the shell stays agnostic of the
command suite: pair it with `@mithic/coreutils`, `@mithic/jq`, and `@mithic/curl`
(as `@mithic/example-shell` and `@mithic/example-desktop` do) and those commands
become spawnable. A single external command is run as a one-stage pipeline so its
stdout is captured back to the shell.

Redirect I/O and glob/pathname expansion go through the guest's `fs/*` syscalls
(via the `FsClient` adapter in `process.ts`), so both require a `vfs` capability;
without it, redirects fail loudly and glob falls back to the literal pattern.

## Quick start

```ts
import { runScript } from '@mithic/shell';

// Builtins only — no external commands needed.
const { stdout, code } = await runScript('echo hello; echo world');
// stdout === 'hello\nworld\n', code === 0
```

`runScript` boots a real `Kernel` over a `WorkerRuntime`, runs a script string,
and returns its captured stdout and exit code. The shell guest is the built
`dist/process.js` module, so **build before use** (the helper imports from
`dist/`). The shell is granted a `process` capability so it can fork children.

### Registering external commands

```ts
// Each value is spawnable guest code (inline ESM source or a module URL); the
// kernel's command resolver maps the name to it.
await runScript('greet | cat', {
  commands: {
    greet: `export default async (boot) => {
      const { createGuest } = await import('@mithic/guest-runtime');
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode('hi\\n'));
      await w.close();
      g.exit(0);
    }`,
  },
});
```

### Driving the executor directly (e.g. an interactive terminal)

```ts
import { Executor, parse } from '@mithic/shell';

const executor = new Executor(kernelClient, { cwd: '/', env: {} }, {
  onStdout: (s) => term.write(s),
  onStderr: (s) => term.write(s),
  resolve: (name) => name,   // delegate command resolution to the kernel
  fs: fsClient,              // enables redirects + glob
});
await executor.run(parse('echo hi | cat'));
```

## Public API

From the package entry (`.`):

- `tokenize`, `Token`, `TokenType`
- `parse`, AST types (`Program`, `Statement`, `SimpleCommand`, `Redirect`,
  `RedirectOp`, `Assignment`)
- `Expander`
- `BUILTINS`, `isBuiltin`, `runBuiltin`, `BuiltinContext`
- `Executor`, `ShellContext`, `ExecutorOptions`, `CommandResolver`
- kernel-client types: `KernelClient`, `FsClient`, `SpawnParams`, `SpawnHandle`,
  `PipelineStageParams`, `PipelineRunResult`, `WaitOutcome`
- `runScript(src, opts?)` → `{ stdout, code }`

The guest entry module is `src/process.ts` (built to `dist/process.js`).

## Build & test

```shell
npm run build       # vite build → dist/ (run from the monorepo root or this package)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Build before testing — the suite (and `runScript`) imports from `dist/`.
