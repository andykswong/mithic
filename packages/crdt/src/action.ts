/** Standard aggregate action interface. */
export interface StandardAction<A extends string = string, T = unknown, K = unknown> {
  /** Action type. */
  readonly type: A;

  /** Action payload. */
  readonly payload: T;

  /** Aggregate root link. */
  readonly root?: K;

  /** Unique value associated with this action. */
  readonly nonce?: string;
}

/** Standard aggregate command. */
export type StandardCommand<A extends string = string, T = unknown, K = unknown>
  = StandardAction<A, T, K>;

/** Standard aggregate event. */
export interface StandardEvent<A extends string = string, T = unknown, K = unknown> extends StandardAction<A, T, K> {
  /** Dependent event links. */
  readonly link?: readonly K[];
}
