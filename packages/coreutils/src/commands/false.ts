/**
 * `false` — do nothing, unsuccessfully.
 * Always exits with status 1.
 */
import { defineCommand } from '../harness.ts';
import type { CommandFn } from '../harness.ts';

const falseCommand: CommandFn = async (): Promise<number> => 1;

export default defineCommand(falseCommand);
export { falseCommand };
