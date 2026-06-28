/**
 * `getcap` — display the file capabilities stored in a file's
 * `security.capability` extended attribute.
 *
 *   getcap FILE...
 *
 * Reads the xattr via `fs/getxattr`, decodes it to a `Capability[]` with the
 * protocol's stable encoding, and prints one line per file: `FILE caps...`.
 * A file with no `security.capability` attribute reports an empty grant.
 */
import { SECURITY_CAPABILITY_XATTR, decodeCapabilities } from '@mithic/protocol';
import type { Capability } from '@mithic/protocol';
import { defineCommand, writeLine } from '../harness.ts';
import { stat, normalize, errnoOf } from '../fs.ts';
import { formatCaps } from './setcap.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const getcapCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const files = io.args.slice(1);
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (files.length === 0) {
      await writeLine(err, 'getcap: missing operand');
      return 1;
    }
    for (const file of files) {
      try {
        const caps = await readCaps(io, normalize(file));
        await writeLine(out, formatCaps(file, caps));
      } catch (e) {
        await writeLine(err, `getcap: ${file}: ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Read+decode a file's caps; a present file with no xattr yields `[]`. */
async function readCaps(io: CommandIO, path: string): Promise<Capability[]> {
  try {
    const bytes = (await io.syscall('fs/getxattr', { path, name: SECURITY_CAPABILITY_XATTR })) as Uint8Array;
    return decodeCapabilities(bytes);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') {
      // ENOENT is ambiguous (missing file OR missing attribute) — disambiguate
      // by stat: if the file exists, an absent attribute means no capabilities.
      await stat(io, path);
      return [];
    }
    throw e;
  }
}

export default defineCommand(getcapCommand);
export { getcapCommand };
