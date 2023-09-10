/** Standard aggregate event interface in Flux standard action format. */
export interface StandardEvent<A extends string = string, T = unknown, Ref = unknown> {
  /** Event type. */
  readonly type: A;

  /** Event payload. */
  readonly payload: T;

  /** Event metadata. */
  readonly meta?: StandardEventMeta<Ref>;
}

/** {@link StandardEvent} metadata. */
export interface StandardEventMeta<Ref = unknown> extends StanardCommandMeta<Ref> {
  /** Parent event references. */
  readonly prev?: readonly Ref[];

  /** Other dependent event references. */
  readonly refs?: readonly Ref[];
}

/** Common metadata for a stanard aggregate command. */
export interface StanardCommandMeta<Ref = unknown> {
  /** Reference to target aggregate root. */
  readonly root?: Ref;

  /** Unique sequence number. */
  readonly seq?: number;

  /** (Logical) timestamp. */
  readonly time?: number;
}
