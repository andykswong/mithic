/** Standard aggregate event interface in Flux standard action format. */
export interface StandardEvent<A extends string = string, T = unknown, Ref = unknown, Meta = StandardEventMeta<Ref>> {
  /** Event type. */
  readonly type: A;

  /** Event payload. */
  readonly payload: T;

  /** Event metadata. */
  readonly meta?: Meta;
}

/** Standard aggregate command interface in Flux standard action format. */
export type StandardCommand<A extends string = string, T = unknown, Ref = unknown, Meta = StanardCommandMeta<Ref>>
  = StandardEvent<A, T, Ref, Meta>;

/** Common metadata for {@link StandardEvent}. */
export interface StandardEventMeta<Ref = unknown> extends StanardCommandMeta<Ref> {
  /** Parent event references. */
  readonly prev?: readonly Ref[];

  /** Other dependent event references. */
  readonly refs?: readonly Ref[];
}

/** Common metadata for {@link StandardCommand}. */
export interface StanardCommandMeta<Ref = unknown> {
  /** Unique correlation ID. */
  readonly id?: string;

  /** Reference to target aggregate root. */
  readonly root?: Ref;

  /** (Logical) timestamp. */
  readonly time?: number;
}
