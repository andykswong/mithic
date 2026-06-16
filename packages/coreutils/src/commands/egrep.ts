/**
 * `egrep` — `grep -E` (Extended Regular Expressions). A thin wrapper: it runs
 * the shared {@link grepCommand}, which detects `argv[0] === 'egrep'` and forces
 * ERE syntax. Built 1:1 to `dist/commands/egrep.js`.
 */
import { defineCommand } from '../harness.ts';
import { grepCommand } from './grep.ts';

export default defineCommand(grepCommand);
export { grepCommand };
