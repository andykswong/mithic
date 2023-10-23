import { AbortOptions, MaybePromise, Startable } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription, StateProvider } from '@mithic/messaging';
import { MessageTranslator } from '../processor/index.js';
import { StandardCommand, StandardEvent } from '../event.js';

/** Binds a command handler to command and event bus and returns a disposable {@link Startable}. */
export function bindCommandHandler<State = undefined, Command = StandardCommand, Event = StandardEvent>(
  /** Source command {@link MessageSubscription} to consume. */
  commandBus: MessageSubscription<Command>,
  /** Output event {@link MessageDispatcher} to use. */
  eventBus: MessageDispatcher<Event>,
  /** Command handler. */
  handler: CommandHandler<State, Command, Event>,
  /** State provider to use. */
  store?: StateProvider<State>,
): Startable & AsyncDisposable {
  const translatorHandler = (command: Command, options?: AbortOptions) => {
    return handler(store?.getState() as State, command, options);
  }
  return new MessageTranslator(commandBus, eventBus, translatorHandler);
}

/** Command handler function. */
export interface CommandHandler<State = undefined, Command = StandardCommand, Event = StandardEvent> {
  (state: State, command: Command, options?: AbortOptions): MaybePromise<Event | undefined>;
}
