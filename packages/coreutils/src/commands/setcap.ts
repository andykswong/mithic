/**
 * `setcap` — set the file capabilities stored in a file's
 * `security.capability` extended attribute.
 *
 *   setcap CAPSPEC FILE...
 *
 * CAPSPEC is a `;`-separated list of capability clauses (the minimal Mithic
 * grammar, mirroring the `Capability` union in `@mithic/protocol`):
 *
 *   fs:<op>[,<op>...]:<path>[,<path>...]   ops ∈ {read,write,execute}
 *   net:<origin>[,<origin>...]
 *   ipc:<channel>[,<channel>...]
 *   process[:<maxChildren>]
 *   env
 *
 * e.g. `setcap 'fs:read,write:/in,/out;process:4' /usr/bin/imgresize`.
 * The parsed `Capability[]` is encoded with the protocol's stable encoding and
 * written via `fs/setxattr` (capability-gated `write`).
 */
import { SECURITY_CAPABILITY_XATTR, encodeCapabilities } from '@mithic/protocol';
import type { Capability } from '@mithic/protocol';
import { defineCommand, writeLine } from '../harness.ts';
import { normalize } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type FsOperation = 'read' | 'write' | 'execute';
const FS_OPERATIONS: ReadonlySet<string> = new Set(['read', 'write', 'execute']);

/** Split on `sep`, trim each piece, and drop empties. */
function splitTrim(s: string, sep: string): string[] {
  return s.split(sep).map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parse a CAPSPEC string into a `Capability[]`. Throws on invalid syntax. */
export function parseCapSpec(spec: string): Capability[] {
  const clauses = splitTrim(spec, ';');
  if (clauses.length === 0) throw new Error(`invalid capability spec: '${spec}'`);
  return clauses.map(parseClause);
}

function parseClause(clause: string): Capability {
  const [type, ...rest] = clause.split(':').map((p) => p.trim());
  switch (type) {
    case 'fs': {
      if (rest.length < 2) throw new Error(`fs capability needs operations and paths: '${clause}'`);
      const ops = splitTrim(rest[0], ',');
      if (ops.length === 0) throw new Error(`fs capability needs at least one operation: '${clause}'`);
      for (const op of ops) {
        if (!FS_OPERATIONS.has(op)) throw new Error(`invalid fs operation '${op}'`);
      }
      const operations = ops as FsOperation[];
      const paths = splitTrim(rest.slice(1).join(':'), ',');
      if (paths.length === 0) throw new Error(`fs capability needs at least one path: '${clause}'`);
      return { type: 'fs', operations, paths };
    }
    case 'net': {
      const origins = splitTrim(rest.join(':'), ',');
      if (origins.length === 0) throw new Error(`net capability needs at least one origin: '${clause}'`);
      return { type: 'net', origins };
    }
    case 'ipc': {
      const channels = splitTrim(rest.join(':'), ',');
      if (channels.length === 0) throw new Error(`ipc capability needs at least one channel: '${clause}'`);
      return { type: 'ipc', channels };
    }
    case 'process': {
      if (rest.length === 0 || rest[0] === '') return { type: 'process' };
      const maxChildren = Number(rest[0]);
      if (!Number.isInteger(maxChildren) || maxChildren < 0) {
        throw new Error(`process maxChildren must be a non-negative integer: '${clause}'`);
      }
      return { type: 'process', maxChildren };
    }
    case 'env':
      return { type: 'env' };
    default:
      throw new Error(`unknown capability type '${type}'`);
  }
}

/** Render a `Capability[]` as a single human-readable line: `FILE clause; clause`. */
export function formatCaps(file: string, caps: Capability[]): string {
  const clauses = caps.map((c) => {
    switch (c.type) {
      case 'fs': return `fs:${c.operations.join(',')}:${c.paths.join(',')}`;
      case 'net': return `net:${c.origins.join(',')}`;
      case 'ipc': return `ipc:${c.channels.join(',')}`;
      case 'process': return c.maxChildren !== undefined ? `process:${c.maxChildren}` : 'process';
      case 'env': return 'env';
    }
  });
  return clauses.length === 0 ? `${file} =` : `${file} ${clauses.join('; ')}`;
}

const setcapCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const operands = io.args.slice(1);
  const err = io.stderr.getWriter();
  let code = 0;

  try {
    if (operands.length < 2) {
      await writeLine(err, 'setcap: usage: setcap CAPSPEC FILE...');
      return 1;
    }
    const [spec, ...files] = operands;
    let caps: Capability[];
    try {
      caps = parseCapSpec(spec);
    } catch (e) {
      await writeLine(err, `setcap: ${(e as Error).message}`);
      return 1;
    }
    const value = encodeCapabilities(caps);
    for (const file of files) {
      try {
        await io.syscall('fs/setxattr', { path: normalize(file), name: SECURITY_CAPABILITY_XATTR, value });
      } catch (e) {
        await writeLine(err, `setcap: ${file}: ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await err.close().catch(() => {});
  }
};

export default defineCommand(setcapCommand);
export { setcapCommand };
