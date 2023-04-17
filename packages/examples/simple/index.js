import assert from 'assert';
import { bindEventCreators } from '@mithic/cqrs';
import { createReduxStore } from '@mithic/cqrs/preset';

// Create a Redux-like store for a counter
const store = createReduxStore({
  initialState: { counter: 0 }, // Initialize count to 0

  // Define a reducer that handles increment and decrement events
  reducer(state, event) {
    switch (event?.type) {
      case 'INCREASED':
        return { ...state, counter: state.counter + (event.count ?? 1) };
      case 'DECREASED':
        return { ...state, counter: state.counter - (event.count ?? 1) };
    }
    return state;
  }
});

// Start the store
await store.start();

// Define and bind the commands to the store
const commands = bindEventCreators({
  increment: (count) => ({ type: 'INCREASED', count }),
  decrement: (count) => ({ type: 'DECREASED', count }),
}, store);

// Run some commands and queries

console.log('Initial state:', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 0 });

await commands.increment(3);
console.log('State after increment(3):', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 3 });

await commands.decrement(1);
console.log('State after increment(1):', store.getState());
assert.deepStrictEqual(store.getState(), { counter: 2 });

// Finally close the store
await store.close();
