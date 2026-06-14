export { instantiate, modules } from '@mithic/coreutils/component';

export const COREUTILS_COMMANDS = new Set([
  'awk', 'cat', 'head', 'tail', 'wc', 'grep', 'seq', 'sort', 'uniq',
  'tr', 'cut', 'tee', 'xargs', 'sleep', 'basename', 'dirname',
  'mkdir', 'rm', 'cp', 'mv', 'ls', 'rmdir', 'touch', 'ln',
  'sed', 'find', 'date', 'diff', 'chmod', 'readlink', 'yes',
  'rev', 'paste', 'base64', 'base32', 'mktemp',
]);
