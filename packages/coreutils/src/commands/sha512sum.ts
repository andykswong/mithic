/** `sha512sum` — print or check SHA-512 checksums. See `_sha.ts`. */
import { defineShaCommand, makeShaCommand } from './_sha.ts';

const sha512sumCommand = makeShaCommand('sha512sum', 'SHA-512');

export default defineShaCommand('sha512sum', 'SHA-512');
export { sha512sumCommand };
