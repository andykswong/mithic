import { AbortOptions, CodedError, MaybePromise } from '@mithic/commons';
import { MessageCreators, MessageName } from '../message.js';
import { MessageBus, MessageDispatcher } from '../bus.js';
import { MessageReducer } from '../processor/index.js';
import { SimpleMessageBus } from '../bus/index.js';
import { ReduxStore, SimpleReduxStore } from './redux.js';

/** Abstract aggregate model. */
export interface Aggregate<Model, Event, Commands extends MessageCreators<Event>> {
  /** Aggregate event creators. */
  command: Commands;

  /** Aggregate event reducer function. */
  reduce: (model: Model, event: Event, options?: AggregateReduceOptions) => MaybePromise<Model>;

  /** Validates given event against aggregate model and returns any error. */
  validate: (model: Model, event: Event, options?: AbortOptions) => MaybePromise<CodedError | undefined>;
}

/** Options for {@link Aggregate} reduce method. */
export interface AggregateReduceOptions extends AbortOptions {
  /** Whether to validate event. Defaults to true. */
  readonly validate?: boolean;
}

/** Creates a simple Redux-compatible CQRS aggregate store. */
export function createAggregateStore<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model, Event, Cmds extends MessageCreators<Event, string, [Model, ...any[]]>
>(
  options: CreateAggregateStoreOptions<Model, Event, Cmds>
): AggregateReduxStore<Model, Event, Cmds> & AsyncDisposable {
  const bus = options.bus ?? new SimpleMessageBus();
  const reducer = new MessageReducer(bus, options.aggregate.reduce, options.initialState);
  const dispatch = (event: Event) => bus.dispatch(event);
  const commands = {} as Record<string, (...args: unknown[]) => MaybePromise<void>>;
  for (const key in options.aggregate.command) {
    commands[key] =
      (...args: unknown[]) => MaybePromise.map(options.aggregate.command[key](reducer.state, ...args), dispatch);
  }
  return new SimpleAggregateStore(bus, commands as AggregateCommands<Model, Event, Cmds>, reducer);
}

/** Options for {@link createAggregateStore}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CreateAggregateStoreOptions<Model, Event, Cmds extends MessageCreators<Event>> {
  /** The aggregate. */
  aggregate: Aggregate<Model, Event, Cmds>;

  /** Initial state. */
  initialState: Model;

  /** Message bus to use. */
  bus?: MessageBus<Event>;
}

/** Aggregate commands type with embedded model. */
export type AggregateCommands<Model, Event, M extends MessageCreators<Event>> = {
  [K in MessageName<M>]: M[K] extends (model: Model, ...args: infer Args) => unknown ?
    (...args: Args) => MaybePromise<void> :
    (...args: Parameters<M[K]>) => MaybePromise<void>;
}

/** Redux-compatible CQRS aggregate store. */
export interface AggregateReduxStore<Model, Event, Cmds extends MessageCreators<Event>> extends ReduxStore<Model, Event> {
  /** Commands for this store. */
  readonly command: AggregateCommands<Model, Event, Cmds>;
}

/** Simple implementation of {@link ReduxStore} for aggregate. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class SimpleAggregateStore<Model, Event, Cmds extends MessageCreators<Event, string, [Model, ...any[]]>>
  extends SimpleReduxStore<Model, Event> implements AggregateReduxStore<Model, Event, Cmds>
{
  public constructor(
    /** Dispatcher to use. */
    dispatcher: MessageDispatcher<Event>,
    /** Commands for this store. */
    public readonly command: AggregateCommands<Model, Event, Cmds>,
    /** Reducer to use. */
    reducer: MessageReducer<Event, Model>,
  ) {
    super(dispatcher, reducer);
  }
}
