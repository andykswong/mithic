import assert from 'assert';
import { AsyncSubscriber, ReduceStore, bindCommandHandler } from '@mithic/cqrs';
import { SimpleMessageBus } from '@mithic/messaging';
import { graphql, parse, subscribe, GraphQLSchema, GraphQLObjectType, GraphQLBoolean, GraphQLInt } from 'graphql';

// Create the message buses and store
const commandBus = new SimpleMessageBus();
const eventBus = new SimpleMessageBus();
const store = new ReduceStore(
  function reduce(state, event) {
    switch (event?.type) {
      case 'INCREASED':
        return { ...state, counter: state.counter + (event.payload ?? 1) };
    }
    return state;
  },
  { counter: 0 },
  eventBus,
);

// Process commands to events
const commandHandler = bindCommandHandler(
  commandBus, eventBus,
  (_state, command) => {
    switch (command?.type) {
      case 'INCREASE':
        return { type: 'INCREASED', payload: command.payload };
    }
  },
  store
);

// Start processing commands and events
await store.start();
await commandHandler.start();
process.on('beforeExit', async () => {
  await commandHandler.close();
  await store.close();
  process.exit(0);
});

// Define the GraphQL schema
const stateType = new GraphQLObjectType({
  name: 'State',
  fields: () => ({ counter: { type: GraphQLInt } })
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      state: {
        type: stateType,
        resolve: () => store.getState() // Returns derived state
      },
    },
  }),

  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      increment: {
        type: GraphQLBoolean,
        args: { count: { type: GraphQLInt } },
        async resolve(_, args) {
          await commandBus.dispatch({ type: 'INCREASE', payload: args.count });
          return true;
        }
      }
    }
  }),

  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      stateChanged: {
        type: stateType,
        subscribe: () => new AsyncSubscriber(store), // subscribes to derived state change
        resolve: (state) => state,
      },
    },
  }),
});

// Subscribe to the state
const subscription = await subscribe({ schema, document: parse('subscription { stateChanged { counter } }') });
console.log('Subscribed to stateChange');

// Run some GraphQL queries and mutations

let result = await graphql({ schema, source: 'query { state { counter } }' });
console.log('Initial state:', JSON.stringify(result.data.state));
assert.deepStrictEqual({ ...result.data.state }, { counter: 0 });

assert.ok((await graphql({ schema, source: 'mutation { increment(count: 3) }' })).data.increment);

result = await graphql({ schema, source: 'query { state { counter } }' });
console.log('New state after increment(3) mutation:', JSON.stringify(result.data.state));
assert.deepStrictEqual({ ...result.data.state }, { counter: 3 });

assert.ok((await graphql({ schema, source: 'mutation { increment(count: 2) }' })).data.increment);

// Pull state changes from subscription
console.log('Pulling stateChange event from subscription');
const expectedStates = [{ counter: 3 }, { counter: 5 }];
let i = 0;
for await (const result of subscription) {
  console.log(`Received state change event ${i}:`, JSON.stringify(result.data.stateChanged));
  assert.deepStrictEqual({ ...result.data.stateChanged }, expectedStates[i]);
  if (++i >= expectedStates.length) {
    break;
  }
}
