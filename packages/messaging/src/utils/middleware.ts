import { MaybePromise } from '@mithic/commons';
import { MessageDispatcher, MessageHandler, MessageOptions, MessageSubscription, SubscribeOptions, Unsubscribe } from '../messaging.js';

/** Apply middlewares to a {@link MessageDispatcher}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyDispatchMiddleware<State, Msg, T extends DispatcherFactory<Msg, any[]>>(
  /** {@link MessageDispatcher} to decorate. */
  Dispatcher: T,
  /** State provider to use. */
  provider: StateProvider<State>,
  /** Middlewares to use. */
  ...middlewares: DispatchMiddleware<State, Msg>[]
) {
  return class extends Dispatcher {
    _dispatch?: MessageDispatcher<Msg>['dispatch'];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public constructor(...args: any[]) {
      super(...args);
      const superDispatch = this.dispatch.bind(this);
      this.dispatch = (msg: Msg, options?: MessageOptions): MaybePromise<void> => {
        if (!this._dispatch) {
          let dispatch = superDispatch;
          for (let i = middlewares.length - 1; i >= 0; i--) {
            const middleware = middlewares[i];
            dispatch = middleware(provider)(dispatch);
          }
          this._dispatch = dispatch;
        }
        return this._dispatch(msg, options);
      }
    }
  };
}

/** Apply middlewares to a {@link MessageSubscription}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applySubscribeMiddleware<State, Msg, T extends SubscriptionFactory<Msg, any[]>>(
  /** {@link MessageSubscription} to decorate. */
  Subscription: T,
  /** State provider to use. */
  provider: StateProvider<State>,
  /** Middlewares to use. */
  ...middlewares: SubscribeMiddleware<State, Msg>[]
) {
  return class extends Subscription {
    _subscribe?: MessageSubscription<Msg>['subscribe'];

    public override subscribe(
      handler: MessageHandler<Msg>, options?: SubscribeOptions<Msg>
    ): MaybePromise<Unsubscribe> {
      if (!this._subscribe) {
        let subscribe = super.subscribe.bind(this);
        for (let i = 0; i < middlewares.length; ++i) {
          const middleware = middlewares[i];
          subscribe = middleware(provider)(subscribe);
        }
        this._subscribe = subscribe;
      }
      return this._subscribe(handler, options);
    }
  };
}

/** Provider of a state object. */
export interface StateProvider<State = unknown> {
  /** Returns the current state. */
  getState(): State;
}

/** Factory to create a {@link MessageDispatcher}. */
export type DispatcherFactory<Msg, Args extends unknown[]> = new (...args: Args) => MessageDispatcher<Msg>;

/** Factory to create a {@link MessageSubscription}. */
export type SubscriptionFactory<Msg, Args extends unknown[]> = new (...args: Args) => MessageSubscription<Msg>;

/** Middleware to apply to a {@link MessageDispatcher}. */
export type DispatchMiddleware<State, Msg> = (provider: StateProvider<State>) =>
  (dispatch: MessageDispatcher<Msg>['dispatch']) => MessageDispatcher<Msg>['dispatch'];

/** Middleware to apply to a {@link MessageSubscription}. */
export type SubscribeMiddleware<State, Msg> = (provider: StateProvider<State>) =>
  (subscribe: MessageSubscription<Msg>['subscribe']) => MessageSubscription<Msg>['subscribe'];
