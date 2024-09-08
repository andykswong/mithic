import { Error } from '@mithic/commons';

/** Runtime config store. */
export interface Config extends Iterable<[key: string, value: string]> {
  /** Deletes the given key. */
  delete(key: string): void;

  /** Sets or replaces value at the given key. */
  set(key: string, value: string): void;

  /**
   * Gets value set at the given key if it exists.
   * @throws {@link ConfigError}
   */
  get(key: string): string | undefined;
}

export const Config = {
  /** The runtime config store instance. */
  runtime: new Map<string, string>() as Config,
};

/** An error type that encapsulates the different errors that can occur when fetching config. */
export class ConfigError extends Error<ConfigErrorPayload, Error> {
  public constructor(payload: ConfigErrorPayload) {
    super(payload.val, { name: ConfigError.name, payload });
  }
}

/** Type of {@link ConfigError}. */
export const ConfigErrorTag = {
  /** This indicates an error from an "upstream" config source. */
  Upstream: 'upstream',
  /** This indicates an error from an I/O operation.  */
  Io: 'io'
} as const;

export type ConfigErrorTag = typeof ConfigErrorTag[keyof typeof ConfigErrorTag];

/** An error that can occur when fetching config. */
export type ConfigErrorPayload = {
  tag: ConfigErrorTag,
  val: string
};
