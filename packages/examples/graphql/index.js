import assert from 'assert';
import { bindEventCreators, AsyncEventSubscriber, SimpleEventBus, EventReducer } from '@mithic/cqrs';
import { graphql, parse, subscribe, GraphQLSchema, GraphQLObjectType, GraphQLBoolean, GraphQLInt } from 'graphql';

// Create the event bus
const eventBus = new SimpleEventBus();

// Derive state using an event reducer
const stateReducer = new EventReducer(
  eventBus,
  function reduce(state, event) {
    switch (event?.type) {
      case 'INCREASED':
        return { ...state, counter: state.counter + (event.count ?? 1) };
    }
    return state;
  },
  { counter: 0 }
);

// Start processing events
await stateReducer.start();
process.on('beforeExit', async () => {
  await stateReducer.close();
  process.exit(0);
});

// Route commands to the event bus
const commands = bindEventCreators({
  increment: (count) => ({ type: 'INCREASED', count }),
}, eventBus);

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
        resolve: () => stateReducer.state // Returns derived state
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
          await commands.increment(args.count);
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
        subscribe: () => new AsyncEventSubscriber(stateReducer), // subscribes to derived state change
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
