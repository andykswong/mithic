/** Standard aggregate action interface. */
export interface StandardAction<A extends string = string, T = unknown, Id = unknown> {
  /** Action type. */
  readonly type: A;

  /** Action payload. */
  readonly payload: T;

  /** Aggregate root ID. */
  readonly root?: Id;

  /** Unique value associated with this action. */
  readonly nonce?: string;
}

/** Standard aggregate command. */
export type StandardCommand<A extends string = string, T = unknown, Id = unknown>
  = StandardAction<A, T, Id>;

/** Standard aggregate event. */
export interface StandardEvent<A extends string = string, T = unknown, Id = unknown> extends StandardAction<A, T, Id> {
  /** Dependent event links. */
  readonly link?: readonly Id[];
}
