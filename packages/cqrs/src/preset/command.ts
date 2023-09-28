import { AbortOptions, MaybePromise, Startable } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription } from '../bus.js';
import { MessageTranslator } from '../processor/index.js';
import { StandardCommand, StandardEvent } from '../event.js';
import { Store } from './store.js';

/** Binds a command handler to command and event bus and returns a disposable {@link Startable}. */
export function bindCommandHandler<Command = StandardCommand, Event = StandardEvent, State = undefined>(
  /** Source command {@link MessageSubscription} to consume. */
  commandBus: MessageSubscription<Command>,
  /** Output event {@link MessageDispatcher} to use. */
  eventBus: MessageDispatcher<Event>,
  /** Command handler. */
  handler: CommandHandler<Command, Event, State>,
  /** State store to use. */
  store?: Store<State>,
): Startable & AsyncDisposable {
  const translatorHandler = (command: Command, options?: AbortOptions) => {
    return handler(store?.getState() as State, command, options);
  }
  return new MessageTranslator(commandBus, eventBus, translatorHandler);
}

/** Command handler function. */
export interface CommandHandler<Command = StandardCommand, Event = StandardEvent, State = undefined> {
  (state: State, command: Command, options?: AbortOptions): MaybePromise<Event | undefined>;
}
