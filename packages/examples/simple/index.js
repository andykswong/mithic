import assert from 'assert';
import { ReduxStore } from '@mithic/cqrs';

// Create a Redux-like store for a counter
const store = new ReduxStore(
  // Define a reducer that handles increment and decrement events
  (state, event) => {
    switch (event?.type) {
      case 'INCREASED':
        return { ...state, counter: state.counter + (event.payload ?? 1) };
      case 'DECREASED':
        return { ...state, counter: state.counter - (event.payload ?? 1) };
    }
    return state;
  },
  // Initialize count to 0
  { counter: 0 },
);

// Start the store
await store.start();

// Run some commands and queries

console.log('Initial state:', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 0 });

await store.dispatch({ type: 'INCREASED', payload: 3 });
console.log('State after increment(3):', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 3 });

await store.dispatch({ type: 'DECREASED', payload: 1 });
console.log('State after increment(1):', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 2 });

// Finally close the store
await store.close();
