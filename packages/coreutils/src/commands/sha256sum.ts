/** `sha256sum` — print or check SHA-256 checksums. See `_sha.ts`. */
import { defineShaCommand, makeShaCommand } from './_sha.ts';

const sha256sumCommand = makeShaCommand('sha256sum', 'SHA-256');

export default defineShaCommand('sha256sum', 'SHA-256');
export { sha256sumCommand };
