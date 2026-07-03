/**
 * `md5sum` — print or check MD5 checksums.
 *
 * All flag parsing, `--tag`/`-b`/`-z` formatting, and the GNU `-c` verification
 * path (with `WARNING:` summaries) are shared with the SHA family via
 * {@link runDigestCommand} — md5sum differs only in supplying a pure-TS RFC 1321
 * MD5 digest (`_md5.ts`), because Web Crypto exposes no MD5.
 */
import { defineCommand } from '../harness.ts';
import { runDigestCommand } from './_sha.ts';
import { md5hex } from './_md5.ts';
import type { CommandFn } from '../harness.ts';

const md5sumCommand: CommandFn = runDigestCommand('md5sum', (bytes) => md5hex(bytes), 32);

export default defineCommand(md5sumCommand);
export { md5sumCommand };
