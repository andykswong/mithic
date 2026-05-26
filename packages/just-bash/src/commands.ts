/**
 * Built-in command registry for JustBashShell.
 * Provides commands that bridge just-bash's command model to mithic ProcessManager.
 */

import type { Command, CommandContext, ExecResult } from 'just-bash';
import type { ProcessManager } from '@mithic/process/types';
import { spawnWithPipes } from '@mithic/process/utils';

/**
 * Create commands that use the ProcessManager to spawn child processes.
 * These commands allow just-bash to invoke external programs (e.g., WASM binaries)
 * via the process manager's spawn mechanism.
 */
export function createProcessCommands(manager: ProcessManager): Command[] {
  return [
    createSpawnCommand(manager),
  ];
}

/**
 * `spawn` command — explicitly spawns a child process via the ProcessManager.
 * Usage: spawn <program> [args...]
 */
function createSpawnCommand(manager: ProcessManager): Command {
  return {
    name: 'spawn',
    trusted: true,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (args.length === 0) {
        return { stdout: '', stderr: 'spawn: missing program name\n', exitCode: 1 };
      }

      const [program, ...programArgs] = args;

      try {
        const { process, stdin, stdout, stderr } = spawnWithPipes(
          manager, program!, programArgs, { cwd: ctx.cwd, env: Object.fromEntries(ctx.env) },
        );

        if (ctx.stdin) {
          const inputBytes = new TextEncoder().encode(ctx.stdin as unknown as string);
          if (inputBytes.byteLength > 0) {
            stdin.write(inputBytes);
          }
        }
        stdin[Symbol.dispose]();

        const exitCode = await process.wait();

        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];

        try {
          let chunk = stdout.read(65536n);
          while (chunk.byteLength > 0) {
            stdoutChunks.push(chunk);
            chunk = stdout.read(65536n);
          }
        } catch (e: unknown) {
          if (!isStreamClosed(e)) throw e;
        }
        try {
          let chunk = stderr.read(65536n);
          while (chunk.byteLength > 0) {
            stderrChunks.push(chunk);
            chunk = stderr.read(65536n);
          }
        } catch (e: unknown) {
          if (!isStreamClosed(e)) throw e;
        }

        const decoder = new TextDecoder();
        return {
          stdout: decoder.decode(concat(stdoutChunks)),
          stderr: decoder.decode(concat(stderrChunks)),
          exitCode,
        };
      } catch (e) {
        if (e === 'not-found') {
          return { stdout: '', stderr: `spawn: ${program}: command not found\n`, exitCode: 127 };
        }
        return { stdout: '', stderr: `spawn: ${String(e)}\n`, exitCode: 1 };
      }
    },
  };
}

function isStreamClosed(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'tag' in e && (e as { tag: string }).tag === 'closed';
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
