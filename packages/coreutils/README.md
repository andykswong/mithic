# @mithic/coreutils

A pure-TypeScript reimplementation of the BusyBox-style Unix coreutils, where
each command is a regular sandboxed Mithic guest process. There is no native
binary and no WebAssembly: every command is a small TypeScript module that reads
its argv/env/cwd, streams over stdio, reaches kernel services through `fs/*`
syscalls, and returns an exit code — running identically in the browser and on
Node.

> These replace the earlier Rust→WASM coreutils. That WASM/WASI implementation
> is paused and preserved on the `wasm` branch (and `origin/main`); it is not part
> of this branch.

## Commands

71 commands, one module per command under `src/commands/`:

```
awk, base32, base64, basename, cat, chmod, cksum, column, comm, cp, cut,
date, diff, dirname, du, echo, egrep, env, expand, expr, false, fgrep,
find, fold, getcap, grep, head, join, ln, ls, md5sum, mkdir, mktemp, mv,
nl, od, paste, printenv, printf, pwd, readlink, realpath, rev, rm, rmdir,
sed, seq, setcap, sha1sum, sha256sum, sha512sum, shuf, sleep, sort, split,
stat, strings, sum, tac, tail, tee, touch, tr, tree, true, unexpand, uniq,
wc, which, xargs, yes
```

The latest batch added `printenv`, `which`, `split`, `od`, `strings`, `du`,
`join`, `expand`/`unexpand`, `column`, `tree`, and the SHA-family checksums
`sha1sum`/`sha256sum`/`sha512sum` (Web Crypto `crypto.subtle.digest` — no
WebAssembly, no deps). `md5sum` ships a pure-TS RFC 1321 MD5 (`_md5.ts`), since
Web Crypto exposes no MD5. A few of these intentionally diverge from GNU where
exact parity is not reproducible over a virtual filesystem or is low-value,
documented in each command's header: `du` uses a `ceil(byte-sum / 1024)` block
model (not `st_blocks`); `od` supports the single-byte (`-t x1`/`o1`/`d1`/`-c`,
`-a` named-ASCII), 2-byte (`-t x2`/`o2`/`d2`), and multiple combined `-t` specs
with `*` duplicate-line elision; and `column`'s `-t` table mode is faithful while
the non-`-t` fill mode is a simplified 80-column pack.

A subsequent GNU-9.11 command-level parity wave (differentially verified against
the `g`-prefixed GNU binaries) brought the suite byte-exact across dozens of
flag- and edge-level gaps — e.g. `cksum` gained `-z`/`--zero` and pure-TS
BLAKE2b/SM3 digests (`-a blake2b`/`-a sm3`), `seq`/`printf` numeric formatting is
round-half-to-even, `expr` handles POSIX character classes, `find` supports
`-prune`, and `sort`/`split`/`head`/`tail`/`uniq`/`tr`/`shuf` reject unknown
options with GNU exit codes. A handful of behaviors remain deliberate documented
deviations (each noted in the command's header): `base32 -d` is case-insensitive
where GNU is case-sensitive, and `sort -R`'s shuffle order is not byte-comparable
to GNU's keyed-hash order.

The authoritative list is the `COMMAND_NAMES` array in `src/resolver.ts`; each
name has a matching `src/commands/<name>.ts`. (`grep` family: `grep`, `egrep`,
`fgrep`; `awk` carries its own sub-engine in `src/commands/awk/` — lexer →
parser → interp.) `getcap`/`setcap` read and write a file's
`security.capability` xattr (the file-capabilities grant) via `fs/getxattr` and
`fs/setxattr`. `jq` and `curl` live in their own packages (`@mithic/jq`,
`@mithic/curl`), not here.

In addition, `src/commands/` carries a few path-arg "Lab" utilities — `copy`,
`csvcols`, and the OffscreenCanvas-backed `imgresize`/`imgconvert` — that take
their input/output as argv VFS paths (via `guest.fs` `readPath`/`writePath`)
rather than streaming over stdio. These are not in `COMMAND_NAMES` and so are
not exposed by `createCoreutilsResolver`; they are installed into `/usr/bin` by
the Lab app (`@mithic/example-lab`) with manifest-sourced capability xattrs.

## Command-module convention

A command is, at its core, a `CommandFn`: a function over a `CommandIO`
(parsed argv + `env` + `cwd` + stdin/stdout/stderr streams + a `syscall` hook)
that returns an exit code. `defineCommand(fn)` wraps that into the guest module
the kernel launches, so each file is just its own logic plus one default export:

```ts
import { defineCommand, parseArgs, readAll, writeBytes } from '../harness.ts';
import type { CommandFn } from '../harness.ts';

const myCommand: CommandFn = async (io) => {
  const { positionals, flags } = parseArgs(io.args.slice(1), { boolean: ['n'] });
  // io.args[0] is the command name; operands/flags follow.
  const out = io.stdout.getWriter();
  await writeBytes(out, await readAll(io.stdin));
  await out.close().catch(() => {});
  return 0;
};

export default defineCommand(myCommand);
export { myCommand }; // exported so the logic is unit-testable without a kernel
```

`defineCommand` builds a `Guest` from the boot payload via `createGuest`
(from `@mithic/guest-runtime`), binds the command's `CommandIO` to the guest's
wired stdio and syscall channel, runs the `CommandFn`, then closes stdout/stderr
and calls `guest.exit(code)`. A thrown error is reported on stderr and becomes
exit code `1`, mirroring a crashing coreutil.

The harness (`src/harness.ts`, re-exported from the package root and from
`@mithic/coreutils/harness`) provides the reusable helpers every command needs:

- `parseArgs(args, opts)` — a POSIX/getopt-style parser: short clustering
  (`-abc`), short value flags (`-o val` / `-oval`), long flags
  (`--flag` / `--flag=val` / `--flag val`), a `--` terminator, counted flags
  (`-vvv` → 3), aliases, and a lone `-` kept as a positional (stdin convention).
- stdin readers — `readAll`, `readAllText`, `readLines`.
- stdout/stderr writers — `writeBytes`, `writeString`, `writeLine`.
- `exitWith(errWriter, code, msg?)` — the error-and-exit-code idiom.

## Resolution and spawning

The kernel owns the command namespace. Commands are not bundled into one
module: the repo's Vite `preserveModules` build emits each `src/commands/<name>.ts`
1:1 to its own `dist/commands/<name>.js`. `createCoreutilsResolver()` returns a
`resolveCommand(name, cwd, env)` that maps a known name to the `file://` URL of
that built module, or `undefined` for an unknown name (so the kernel yields
ENOENT). Wire it into the kernel:

```ts
import { Kernel } from '@mithic/kernel';
import { createCoreutilsResolver } from '@mithic/coreutils';

const kernel = new Kernel({ runtime, vfs, resolveCommand: createCoreutilsResolver() });
```

When a guest (typically `@mithic/shell`) spawns a bare name via `process/spawn`
or `process/pipeline`, the kernel calls `resolveCommand`, then its launcher
imports the resolved module URL with normal ESM resolution and runs it as a
sandboxed guest — exactly how the shell's own `dist/process.js` is launched.
`createCoreutilsResolver` accepts `{ only }` to expose a subset of
`COMMAND_NAMES`, and `{ baseUrl }` for unusual hosting layouts.

## Build & test

```shell
npm run build       # vite build (preserveModules) → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Run from the monorepo root to capture cross-package effects; build before test,
since suites import from `dist/`.
