import { jest } from '@jest/globals';
import { EventCreator, EventCreators, EventGenerator, EventGenerators, bindEventCreator, bindEventCreators, bindEventGenerator, bindEventGenerators } from '../command.js';
import { EventDispatcher } from '../event.js';
import { SimpleEventBus } from '../index.js';

const ARG0 = 123;
const ARG1 = true;
const EVENT = 'test';
const EVENT2 = 'test2';

describe(bindEventCreator.name, () => {
  let dispatcher: EventDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<EventDispatcher<string>['dispatch']>;

  beforeEach(() => {
    dispatcher = new SimpleEventBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
  });

  it('should bind sync event creator', () => {
    const eventCreator = jest.fn<EventCreator<[number, boolean], string>>()
      .mockReturnValueOnce(EVENT);
    const command = bindEventCreator(eventCreator, dispatcher);
    expect(command(ARG0, ARG1)).toBeUndefined();
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
  });

  it('should bind async event creator', async () => {
    const eventCreator = jest.fn<EventCreator<[number, boolean], string>>()
      .mockReturnValueOnce(Promise.resolve(EVENT));
    const command = bindEventCreator(eventCreator, dispatcher);
    await expect(command(ARG0, ARG1)).resolves.toBeUndefined();
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
  });
});

describe(bindEventGenerator.name, () => {
  let dispatcher: EventDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<EventDispatcher<string>['dispatch']>;

  beforeEach(() => {
    dispatcher = new SimpleEventBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
  });

  it('should bind sync event generator', () => {
    const eventGenerator = jest.fn<EventGenerator<[number, boolean], string>>(function* (arg0: number, arg1: boolean) {
      yield `${arg0}`;
      yield `${arg1}`;
    });
    const command = bindEventGenerator(eventGenerator, dispatcher);
    expect(command(ARG0, ARG1)).toBeUndefined();
    expect(eventGenerator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, `${ARG0}`);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, `${ARG1}`);
  });

  it('should bind async event generator', async () => {
    const eventGenerator = jest.fn<EventGenerator<[number, boolean], string>>(async function* (arg0: number, arg1: boolean) {
      yield Promise.resolve(`${arg0}`);
      yield Promise.resolve(`${arg1}`);
    });
    const command = bindEventGenerator(eventGenerator, dispatcher);
    await expect(command(ARG0, ARG1)).resolves.toBeUndefined();
    expect(eventGenerator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, `${ARG0}`);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, `${ARG1}`);
  });
});

type TestEventCreatorTypes = {
  event1: [[number], string];
  event2: [[boolean], string];
};

describe(bindEventCreators.name, () => {
  let dispatcher: EventDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<EventDispatcher<string>['dispatch']>;
  let eventCreators: EventCreators<TestEventCreatorTypes>;

  beforeEach(() => {
    dispatcher = new SimpleEventBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    eventCreators = {
      event1: jest.fn<EventCreator<[number], string>>()
        .mockReturnValueOnce(Promise.resolve(EVENT)),
      event2: jest.fn<EventCreator<[boolean], string>>()
        .mockReturnValueOnce(Promise.resolve(EVENT2)),
    };
  });

  it('should bind event creators', async () => {
    const commands = bindEventCreators(eventCreators, dispatcher);

    await commands.event1(ARG0);
    expect(eventCreators.event1).toHaveBeenCalledWith(ARG0);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT);

    await commands.event2(ARG1);
    expect(eventCreators.event2).toHaveBeenCalledWith(ARG1);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT2);
  });
});

describe(bindEventGenerators.name, () => {
  let dispatcher: EventDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<EventDispatcher<string>['dispatch']>;
  let eventGenerators: EventGenerators<TestEventCreatorTypes>;

  beforeEach(() => {
    dispatcher = new SimpleEventBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    eventGenerators = {
      event1: jest.fn<EventGenerator<[number], string>>(async function* (arg: number) {
        expect(arg).toBe(ARG0);
        yield Promise.resolve(EVENT);
      }),
      event2: jest.fn<EventGenerator<[boolean], string>>(async function* (arg: boolean) {
        expect(arg).toBe(ARG1);
        yield Promise.resolve(EVENT2);
      }),
    };
  });

  it('should bind event generators', async () => {
    const commands = bindEventGenerators(eventGenerators, dispatcher);

    await commands.event1(ARG0);
    expect(eventGenerators.event1).toHaveBeenCalledWith(ARG0);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT);

    await commands.event2(ARG1);
    expect(eventGenerators.event2).toHaveBeenCalledWith(ARG1);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT2);
  });
});
