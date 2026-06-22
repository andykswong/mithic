/**
 * Boot configuration for `@mithic/example-shell`: the capabilities granted to
 * spawned commands, the demo files seeded into the VFS, the xterm.js terminal
 * options, and {@link getBashrc} — the `.bashrc` script the terminal *sources*
 * at boot (printed by the real shell via `echo -e`, not a hardcoded write).
 */
import type { Capability } from '@mithic/protocol';
import type { ITerminalOptions } from '@xterm/xterm';

/** Capabilities granted to every spawned command: read+write the whole VFS, the
 * device tree (`/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/null`), and HTTP
 * for curl. The distinct `/dev` grant matches the `/dev` mount in main.ts so
 * `head -c N /dev/urandom` / `cat /dev/zero | …` can open the device provider. */
export const CHILD_CAPABILITIES: Capability[] = [
  { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  { type: 'fs', paths: ['/dev'], operations: ['read', 'write'] },
  { type: 'net', origins: ['*'] },
];

/** Demo files seeded into the VFS so a fresh terminal has something to explore. */
export const SEED_FILES: Record<string, string> = {
  '/welcome.txt': 'Welcome to the Mithic shell!\nEverything here runs sandboxed in your browser.\n',
  '/fruits.txt': 'banana\napple\ncherry\napple\nbanana\napple\n',
  '/data.json': '{"name":"mithic","stars":42,"tags":["wasm","shell","vfs"]}\n',
  '/numbers.txt': '3\n1\n4\n1\n5\n9\n2\n6\n',
  '/tmp/.keep': '',
};

/** xterm.js terminal options for the browser TTY. */
export const TERMINAL_CONFIG: ITerminalOptions = {
  convertEol: true,
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 14,
  theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
};

/**
 * The boot `.bashrc` SCRIPT (a shell string the terminal sources at boot). It
 * is a sequence of `echo -e` lines whose backslash escapes — `\033[…m` (ANSI),
 * `\033]8;;URL\007…\033]8;;\007` (OSC-8 hyperlinks) — are rendered by the shell's
 * `echo -e` (see `interpretEscapes` in `@mithic/shell`). The final line exports
 * the bash-style PS1 the REPL then expands via `expandPrompt`.
 *
 * Escaping note: this is a TS template literal producing a shell script, so the
 * SHELL must receive `\033`/`\007`/`\e`. We therefore write `\\033` in TS (one
 * backslash reaches the shell) — then `echo -e` turns `\033` into ESC at runtime.
 */
export function getBashrc(): string {
  return `
echo -e ""
echo -e "  \\033[1;35m███╗   ███╗██╗████████╗██╗  ██╗██╗ ██████╗\\033[0m"
echo -e "  \\033[1;35m████╗ ████║██║╚══██╔══╝██║  ██║██║██╔════╝\\033[0m"
echo -e "  \\033[1;35m██╔████╔██║██║   ██║   ███████║██║██║     \\033[0m"
echo -e "  \\033[1;35m██║╚██╔╝██║██║   ██║   ██╔══██║██║██║     \\033[0m"
echo -e "  \\033[1;35m██║ ╚═╝ ██║██║   ██║   ██║  ██║██║╚██████╗\\033[0m"
echo -e "  \\033[1;35m╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝ ╚═════╝\\033[0m"
echo -e ""
echo -e "\\033[1;35mmithic shell\\033[0m — a sandboxed POSIX-style shell in your browser"
echo -e "\\033[2mThe coreutils + jq + curl suite runs as real sandboxed processes.\\033[0m"
echo -e ""
echo -e "  \\033[1;36mnpm install mithic\\033[0m"
echo -e ""
echo -e "\\033[2mLinks:\\033[0m \\033]8;;https://github.com/andykswong/mithic\\007\\033[4;36mGitHub\\033[0m\\033]8;;\\007  \\033]8;;https://andykswong.github.io/mithic/api\\007\\033[4;36mAPI Docs\\033[0m\\033]8;;\\007"
echo -e ""
echo -e "\\033[2mTry:\\033[0m"
echo -e "  \\033[36mls\\033[0m                                   list the seeded files"
echo -e "  \\033[36mcat welcome.txt\\033[0m"
echo -e "  \\033[36mecho hi | grep h\\033[0m"
echo -e "  \\033[36msort fruits.txt | uniq -c\\033[0m"
echo -e "  \\033[36mseq 1 5 | awk '{s+=\\$1}END{print s}'\\033[0m"
echo -e "  \\033[36mcat data.json | jq .tags\\033[0m"
echo -e ""
export PS1="\\e[1;32m\\w\\e[0m\\$ "
`;
}
