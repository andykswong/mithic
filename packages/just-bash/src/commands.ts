import type { Command, CommandContext, ExecResult } from 'just-bash';
import type { ProcessManager } from '@mithic/process/types';
import { isStreamClosed } from '@mithic/wasip2/io/streams';
export const RUN_COMMAND_NAME = 'run';

export function createProcessCommands(manager: ProcessManager): Command[] {
  return [
    createRunCommand(manager),
  ];
}

function createRunCommand(manager: ProcessManager): Command {
  return {
    name: RUN_COMMAND_NAME,
    trusted: true,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (args.length === 0) {
        return { stdout: '', stderr: 'run: missing program name\n', exitCode: 1 };
      }

      const [program, ...programArgs] = args;

      try {
        // Pre-fill stdin pipe before spawning so the child can read immediately.
        // Same-thread QueuePipe can't block, so data must be present before the child runs.
        const stdinPipe = manager.createPipe();
        const stdoutPipe = manager.createPipe();
        const stderrPipe = manager.createPipe();

        if (ctx.stdin) {
          const inputBytes = new TextEncoder().encode(ctx.stdin as unknown as string);
          if (inputBytes.byteLength > 0) {
            stdinPipe.output.write(inputBytes);
          }
        }
        stdinPipe.output[Symbol.dispose]();

        const process = manager.spawn(program!, programArgs, {
          cwd: ctx.cwd,
          env: Object.fromEntries(ctx.env),
          stdin: stdinPipe.input,
          stdout: stdoutPipe.output,
          stderr: stderrPipe.output,
        });

        const exitCode = await process.wait();

        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];

        try {
          let chunk = stdoutPipe.input.read(65536n);
          while (chunk.byteLength > 0) {
            stdoutChunks.push(chunk);
            chunk = stdoutPipe.input.read(65536n);
          }
        } catch (e: unknown) {
          if (!isStreamClosed(e)) throw e;
        }
        try {
          let chunk = stderrPipe.input.read(65536n);
          while (chunk.byteLength > 0) {
            stderrChunks.push(chunk);
            chunk = stderrPipe.input.read(65536n);
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
          return { stdout: '', stderr: `run: ${program}: command not found\n`, exitCode: 127 };
        }
        return { stdout: '', stderr: `run: ${String(e)}\n`, exitCode: 1 };
      }
    },
  };
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
