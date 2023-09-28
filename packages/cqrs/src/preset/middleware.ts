import { AbortOptions } from '@mithic/commons';
import { MessageDispatcher } from '../bus.js';
import { Store } from './store.js';

/** Apply middlewares to a {@link MessageDispatcher}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyMiddleware<State, Msg, T extends new (...args: any[]) => MessageDispatcher<Msg>>(
  /** {@link MessageDispatcher} to decorate. */
  Dispatcher: T,
  /** State store to use. */
  store: Store<State>,
  /** Middlewares to use. */
  ...middlewares: DispatcherMiddleware<State, Msg>[]
) {
  return class extends Dispatcher {
    _dispatch?: MessageDispatcher<Msg>['dispatch'];

    public override dispatch(msg: Msg, options?: AbortOptions) {
      if (!this._dispatch) {
        let dispatch = (msg: Msg, options: AbortOptions) => super.dispatch(msg, options);
        for (let i = middlewares.length - 1; i >= 0; i--) {
          const middleware = middlewares[i];
          dispatch = middleware(store)(dispatch);
        }
        this._dispatch = dispatch;
      }
      return this._dispatch(msg, options);
    }
  };
}

/** Factory to create a {@link MessageDispatcher}. */
export type DispatcherFactory<Msg, Args extends unknown[]> = new (...args: Args) => MessageDispatcher<Msg>;

/** Middleware to apply to a {@link MessageDispatcher}. */
export type DispatcherMiddleware<State, Msg> =
  (store: Store<State>) => (dispatch: MessageDispatcher<Msg>['dispatch']) => MessageDispatcher<Msg>['dispatch'];
