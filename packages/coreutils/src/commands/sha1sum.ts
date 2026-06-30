/** `sha1sum` — print or check SHA-1 (160-bit) checksums. See `_sha.ts`. */
import { defineShaCommand, makeShaCommand } from './_sha.ts';

const sha1sumCommand = makeShaCommand('sha1sum', 'SHA-1');

export default defineShaCommand('sha1sum', 'SHA-1');
export { sha1sumCommand };
