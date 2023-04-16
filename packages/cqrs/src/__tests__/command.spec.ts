import { jest } from '@jest/globals';
import { EventCreator, EventCreators, bindEventCreator, bindEventCreators } from '../command.js';
import { EventDispatcher } from '../event.js';
import { SimpleEventBus } from '../index.js';

const ARG0 = 123;
const ARG1 = true;
const EVENT = 'test';
const EVENT2 = 'test2';

describe(bindEventCreator.name, () => {
  let dispatcher: EventDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<EventDispatcher<string>['dispatch']>;
  let eventCreator: EventCreator<[number, boolean], string>;

  beforeEach(() => {
    dispatcher = new SimpleEventBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    eventCreator = jest.fn<EventCreator<[number, boolean], string>>()
      .mockReturnValueOnce(Promise.resolve(EVENT));
  });

  it('should bind event creator', async () => {
    const command = bindEventCreator(eventCreator, dispatcher);
    await command(ARG0, ARG1);
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
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
    const commands = bindEventCreators<TestEventCreatorTypes>(eventCreators, dispatcher);

    await commands.event1(ARG0);
    expect(eventCreators.event1).toHaveBeenCalledWith(ARG0);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT);

    await commands.event2(ARG1);
    expect(eventCreators.event2).toHaveBeenCalledWith(ARG1);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT2);
  });
});
