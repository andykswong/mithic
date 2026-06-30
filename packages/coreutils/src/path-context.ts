/**
 * Shared {@link PathContext} factory for the path-arg web utilities.
 *
 * The `copy`/`imgconvert`/`imgresize`/`csvcols` utilities all move bytes by VFS
 * path through the standard File System Access surface (`readPath`/`writePath`),
 * which read a {@link PathContext} over a {@link CommandIO}. They built that
 * context identically; this lifts the one shape into a single helper.
 */
import { createStorageManager } from '@mithic/guest-runtime';
import type { PathContext } from '@mithic/guest-runtime';
import type { CommandIO } from './harness.ts';

/** A {@link PathContext} (the surface `readPath`/`writePath` read) over the command IO. */
export function pathContext(io: CommandIO): PathContext {
  return { cwd: io.cwd, fs: createStorageManager(io.syscall, io.cwd) };
}
