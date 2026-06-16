/**
 * `fgrep` — `grep -F` (fixed strings). A thin wrapper: it runs the shared
 * {@link grepCommand}, which detects `argv[0] === 'fgrep'` and forces
 * fixed-string syntax. Built 1:1 to `dist/commands/fgrep.js`.
 */
import { defineCommand } from '../harness.ts';
import { grepCommand } from './grep.ts';

export default defineCommand(grepCommand);
export { grepCommand };
