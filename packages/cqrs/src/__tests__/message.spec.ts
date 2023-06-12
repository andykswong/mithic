import { jest } from '@jest/globals';
import { MessageCreator, MessageCreators, MessageGenerator, MessageGenerators, bindMessageCreator, bindMessageCreators, bindMessageGenerator, bindMessageGenerators } from '../message.js';
import { MessageDispatcher } from '../bus.js';
import { SimpleMessageBus } from '../index.js';

const ARG0 = 123;
const ARG1 = true;
const EVENT = 'test';
const EVENT2 = 'test2';

describe(bindMessageCreator.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
  });

  it('should bind sync message creator', () => {
    const eventCreator = jest.fn<MessageCreator<[number, boolean], string>>()
      .mockReturnValueOnce(EVENT);
    const command = bindMessageCreator(eventCreator, dispatcher);
    expect(command(ARG0, ARG1)).toBeUndefined();
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
  });

  it('should bind async event creator', async () => {
    const eventCreator = jest.fn<MessageCreator<[number, boolean], string>>()
      .mockReturnValueOnce(Promise.resolve(EVENT));
    const command = bindMessageCreator(eventCreator, dispatcher);
    await expect(command(ARG0, ARG1)).resolves.toBeUndefined();
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
  });
});

describe(bindMessageGenerator.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
  });

  it('should bind sync message generator', () => {
    const eventGenerator = jest.fn<MessageGenerator<[number, boolean], string>>(function* (arg0: number, arg1: boolean) {
      yield `${arg0}`;
      yield `${arg1}`;
    });
    const command = bindMessageGenerator(eventGenerator, dispatcher);
    expect(command(ARG0, ARG1)).toBeUndefined();
    expect(eventGenerator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, `${ARG0}`);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, `${ARG1}`);
  });

  it('should bind async message generator', async () => {
    const eventGenerator = jest.fn<MessageGenerator<[number, boolean], string>>(async function* (arg0: number, arg1: boolean) {
      yield Promise.resolve(`${arg0}`);
      yield Promise.resolve(`${arg1}`);
    });
    const command = bindMessageGenerator(eventGenerator, dispatcher);
    await expect(command(ARG0, ARG1)).resolves.toBeUndefined();
    expect(eventGenerator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, `${ARG0}`);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, `${ARG1}`);
  });
});

type TestMessageCreatorTypes = {
  event1: [[number], string];
  event2: [[boolean], string];
};

describe(bindMessageCreators.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;
  let creators: MessageCreators<TestMessageCreatorTypes>;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    creators = {
      event1: jest.fn<MessageCreator<[number], string>>()
        .mockReturnValueOnce(Promise.resolve(EVENT)),
      event2: jest.fn<MessageCreator<[boolean], string>>()
        .mockReturnValueOnce(Promise.resolve(EVENT2)),
    };
  });

  it('should bind event creators', async () => {
    const commands = bindMessageCreators(creators, dispatcher);

    await commands.event1(ARG0);
    expect(creators.event1).toHaveBeenCalledWith(ARG0);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT);

    await commands.event2(ARG1);
    expect(creators.event2).toHaveBeenCalledWith(ARG1);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT2);
  });
});

describe(bindMessageGenerators.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;
  let generators: MessageGenerators<TestMessageCreatorTypes>;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    generators = {
      event1: jest.fn<MessageGenerator<[number], string>>(async function* (arg: number) {
        expect(arg).toBe(ARG0);
        yield Promise.resolve(EVENT);
      }),
      event2: jest.fn<MessageGenerator<[boolean], string>>(async function* (arg: boolean) {
        expect(arg).toBe(ARG1);
        yield Promise.resolve(EVENT2);
      }),
    };
  });

  it('should bind event generators', async () => {
    const commands = bindMessageGenerators(generators, dispatcher);

    await commands.event1(ARG0);
    expect(generators.event1).toHaveBeenCalledWith(ARG0);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT);

    await commands.event2(ARG1);
    expect(generators.event2).toHaveBeenCalledWith(ARG1);
    expect(dispatchSpy).toHaveBeenLastCalledWith(EVENT2);
  });
});
