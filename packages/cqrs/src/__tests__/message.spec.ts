import { jest } from '@jest/globals';
import { MessageCreator, MessageGenerator, bindMessageCreator, bindMessageCreators, bindMessageGenerator, bindMessageGenerators } from '../message.js';
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
    const eventCreator = jest.fn<MessageCreator<string, [a: number, b: boolean]>>()
      .mockReturnValueOnce(EVENT);
    const command = bindMessageCreator(eventCreator, dispatcher);
    expect(command(ARG0, ARG1)).toBeUndefined();
    expect(eventCreator).toHaveBeenCalledWith(ARG0, ARG1);
    expect(dispatchSpy).toHaveBeenCalledWith(EVENT);
  });

  it('should bind async event creator', async () => {
    const eventCreator = jest.fn<MessageCreator<string, [a: number, b: boolean]>>()
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
    const eventGenerator = jest.fn<MessageGenerator<string, [number, boolean]>>(function* (arg0: number, arg1: boolean) {
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
    const eventGenerator = jest.fn<MessageGenerator<string, [number, boolean]>>(async function* (arg0: number, arg1: boolean) {
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

type TestMessageCreators = {
  event1: MessageCreator<string, [a: number]>,
  event2: MessageCreator<string, [b: boolean]>
};

describe(bindMessageCreators.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;
  let creators: TestMessageCreators;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    creators = {
      event1: jest.fn<MessageCreator<string, [number]>>()
        .mockReturnValueOnce(Promise.resolve(EVENT)),
      event2: jest.fn<MessageCreator<string, [boolean]>>()
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

type TestMessageGenerators = {
  event1: MessageGenerator<string, [a: number]>,
  event2: MessageGenerator<string, [b: boolean]>
};

describe(bindMessageGenerators.name, () => {
  let dispatcher: MessageDispatcher<string>;
  let dispatchSpy: jest.SpiedFunction<MessageDispatcher<string>['dispatch']>;
  let generators: TestMessageGenerators;

  beforeEach(() => {
    dispatcher = new SimpleMessageBus();
    dispatchSpy = jest.spyOn(dispatcher, 'dispatch');
    generators = {
      event1: jest.fn<MessageGenerator<string, [a: number]>>(async function* (arg: number) {
        expect(arg).toBe(ARG0);
        yield Promise.resolve(EVENT);
      }),
      event2: jest.fn<MessageGenerator<string, [b: boolean]>>(async function* (arg: boolean) {
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
