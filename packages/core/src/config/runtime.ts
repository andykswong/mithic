import { Config } from './store.ts';

/**
 * Gets a single opaque config value set at the given key if it exists.
 * @throws {@link ConfigError}
 */
export function get(key: string): string | undefined {
  return Config.runtime.get(key);
}

/**
 * Gets a list of all set config data.
 * @throws {@link ConfigError}
 */
export function getAll(): [key: string, value: string][] {
  return [...Config.runtime];
}
