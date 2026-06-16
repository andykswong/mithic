# @mithic/example-shell

An interactive **browser terminal** for Mithic 2.0: an [xterm.js](https://xtermjs.org/)
front-end driving the JavaScript `@mithic/shell` interpreter, which runs over an
`@mithic/kernel` `Kernel` with the full `@mithic/coreutils` + `@mithic/jq` +
`@mithic/curl` command suite available as sandboxed processes.

```
xterm.js  ──keystrokes──▶  line editor  ──command line──▶  @mithic/shell Executor
   ▲                                                              │
   └──────────────── stdout / stderr ◀── builtins (in-process) ───┤
                                          externals ──▶ Kernel.spawn / runPipeline
                                                          │
                                            coreutils / jq / curl guest processes
```

## What it does

- A real REPL: prompt, line editing (backspace, Enter), command history
  (Up/Down arrows), and Ctrl+C to cancel a line.
- Builtins (`cd`, `pwd`, `echo`, var assignments, control flow, …) run in-process
  in the shell interpreter; `cwd`/env persist across command lines.
- External commands — `cat`, `grep`, `sort`, `uniq`, `seq`, `awk`, `tr`, `wc`,
  `jq`, `curl`, and the rest of the suite — are spawned as sandboxed guest
  processes through the kernel and connected with zero-hop pipes.
- A seeded in-memory VFS (`/welcome.txt`, `/fruits.txt`, `/data.json`,
  `/numbers.txt`, `/tmp`) so you can try things immediately.

Try:

```sh
ls
cat welcome.txt
echo hi | grep h
sort fruits.txt | uniq -c
seq 1 5 | awk '{s+=$1}END{print s}'
cat data.json | jq .tags
echo hi > /tmp/x.txt; cat /tmp/x.txt
```

## Run it

```sh
npm run dev        # vite dev server — open the printed URL
npm run build      # production build into dist/
npm run start      # preview the production build
npm test           # the Chromium browser test (vitest --project browser)
```

## How command loading works in the browser

The production command resolvers map a name to its built `dist` guest module
**URL**, which the kernel normally `import()`s inside a Worker/iframe. That works
in Node but not in a browser sandbox, where the guest's transitive bare
`@mithic/guest-runtime` import cannot be resolved. So this example statically
imports every command's guest module through the bundler (Vite `import.meta.glob`)
and runs the matched guest **in-process** via a custom kernel `GuestLauncher`
(`src/commands.ts`). No URL import, no Worker — it runs identically in the
browser, under vitest's Chromium, and in Node.
