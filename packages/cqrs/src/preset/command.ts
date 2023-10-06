import { AbortOptions, MaybePromise, Startable } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription, StateProvider } from '@mithic/messaging';
import { MessageTranslator } from '../processor/index.js';
import { StandardCommand, StandardEvent } from '../event.js';

/** Binds a command handler to command and event bus and returns a disposable {@link Startable}. */
export function bindCommandHandler<Command = StandardCommand, Event = StandardEvent, State = undefined>(
  /** Source command {@link MessageSubscription} to consume. */
  commandBus: MessageSubscription<Command>,
  /** Output event {@link MessageDispatcher} to use. */
  eventBus: MessageDispatcher<Event>,
  /** Command handler. */
  handler: CommandHandler<Command, Event, State>,
  /** State provider to use. */
  store?: StateProvider<State>,
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
