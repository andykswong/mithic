import type { SyncFileSystemProvider } from '@mithic/io/vfs';
import type { CommandContext } from '@mithic/process/manager/simple';

const enc = new TextEncoder();

export function createChmodHandler(memFs: SyncFileSystemProvider) {
  return function chmodHandler(args: string[], ctx: CommandContext): number {
    return runChmod(args, memFs, (msg) => ctx.stderr.blockingWriteAndFlush(enc.encode(msg)));
  };
}

export function runChmod(
  args: string[],
  memFs: SyncFileSystemProvider,
  writeError?: (msg: string) => void,
): number {
  const isSymbolicMode = (a: string) => /^[ugoa]*[+\-=][rwxXst]*$/.test(a);
  const nonFlags = args.filter(a => !a.startsWith('-') || isSymbolicMode(a));
  const modeStr = nonFlags[0];
  const paths = nonFlags.slice(1);
  let exitCode = 0;
  if (!modeStr || paths.length === 0) {
    writeError?.('chmod: missing operand\n');
    exitCode = 1;
  } else if (/^[0-7]+$/.test(modeStr)) {
    const mode = parseInt(modeStr, 8);
    for (const p of paths) {
      try { memFs.chmod(p, mode); } catch { exitCode = 1; }
    }
  } else {
    const match = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(modeStr);
    if (!match) {
      writeError?.(`chmod: invalid mode: '${modeStr}'\n`);
      exitCode = 1;
    } else {
      const [, who, op, perms] = match;
      const targets = who === '' ? 'ugo' : who.replace('a', 'ugo');
      for (const p of paths) {
        try {
          const stat = memFs.stat(p);
          let mode = stat.mode;
          let bits = 0;
          if (perms.includes('r')) bits |= 0o444;
          if (perms.includes('w')) bits |= 0o222;
          if (perms.includes('x') || perms.includes('X')) bits |= 0o111;
          let mask = 0;
          if (targets.includes('u')) mask |= 0o700;
          if (targets.includes('g')) mask |= 0o070;
          if (targets.includes('o')) mask |= 0o007;
          bits &= mask;
          if (op === '+') mode |= bits;
          else if (op === '-') mode &= ~bits;
          else mode = (mode & ~mask) | bits;
          memFs.chmod(p, mode);
        } catch { exitCode = 1; }
      }
    }
  }
  return exitCode;
}
