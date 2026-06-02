import type { SyncInstantiateFn } from './registry.ts';

/**
 * Evaluate jco-transpiled component JS source to extract the sync instantiate function.
 * This is coupled to jco ^1.20 output format (single export function instantiate(...)).
 */
export function evalJcoSource(jsSource: string): SyncInstantiateFn {
  const stripped = jsSource
    .replace(/^export\s+/gm, '')
    .replace(/^import\s+.*$/gm, '')
    .replace(/import\.meta/g, '__importMeta');
  return new Function('__importMeta', `${stripped}\nreturn instantiate;`)({ url: 'file:///component' }) as SyncInstantiateFn;
}
