/**
 * `true` — do nothing, successfully.
 * Always exits with status 0.
 */
import { defineCommand } from '../harness.ts';
import type { CommandFn } from '../harness.ts';

const trueCommand: CommandFn = async (): Promise<number> => 0;

export default defineCommand(trueCommand);
export { trueCommand };
