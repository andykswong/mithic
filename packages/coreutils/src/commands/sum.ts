/**
 * `sum` — print BSD checksum and block count.
 * Implementation lives in cksum.ts (shared file reader + BSD sum algorithm).
 */
import { defineCommand } from '../harness.ts';
import { sumCommand } from './cksum.ts';

export default defineCommand(sumCommand);
export { sumCommand };
