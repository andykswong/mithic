import { AbortOptions, Startable } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription, StateProvider } from '@mithic/messaging';
import { MessageTransformer } from '../processor/index.js';
import { StandardCommand, StandardEvent } from '../event.js';
import { CommandHandler } from '../handler.js';

/** Binds a command handler to command and event bus and returns a disposable {@link Startable}. */
export function bindCommandHandler<
  State = undefined, Command = StandardCommand, Event = StandardEvent, HandlerOpts = object
>(
  /** Source command {@link MessageSubscription} to consume. */
  commandBus: MessageSubscription<Command, HandlerOpts>,
  /** Output event {@link MessageDispatcher} to use. */
  eventBus: MessageDispatcher<Event>,
  /** Command handler. */
  handler: CommandHandler<State, Command, Event, HandlerOpts>,
  /** State provider to use. */
  store?: StateProvider<State>,
): Startable & AsyncDisposable {
  const wrappedHandler = (command: Command, options?: AbortOptions & HandlerOpts) => {
    return handler(store?.getState() as State, command, options);
  }
  return new MessageTransformer(commandBus, eventBus, wrappedHandler);
}
