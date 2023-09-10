import { jest } from '@jest/globals';
import { SharedCountingSemaphore, delay } from '@mithic/commons';
import { RunnableTask, TaskQueue } from '../task.js';

describe(TaskQueue.name, () => {
  let taskQueue: TaskQueue;

  beforeEach(() => {
    taskQueue = new TaskQueue();
  });

  describe('constructor', () => {
    it('should initialize paused state to false by default', () => {
      expect(taskQueue['paused']).toBe(false);
      expect(taskQueue.started).toBe(true);
    });

    it('should initialize the queue with an empty array by default', () => {
      expect(taskQueue['queue']).toHaveLength(0);
    });

    it('should initialize the semaphore with a SharedCountingSemaphore instance by default', () => {
      expect(taskQueue['lock']).toBeInstanceOf(SharedCountingSemaphore);
    });
  });

  describe('push', () => {
    it('should add a task to the queue', async () => {
      expect.assertions(4);

      const expected = 'result';
      const task = jest.fn<() => Promise<string>>().mockImplementation(async () => {
        expect(taskQueue.pending).toBe(1);
        return expected;
      });
      const promise = taskQueue.push(task);

      expect(taskQueue.size).toBe(1);

      const actual = await promise;
      expect(actual).toBe(expected);
      expect(taskQueue.size).toBe(0);
    });

    it('should queue tasks to be executed with semaphore locking', async () => {
      const tryAcquireSpy = jest.spyOn(taskQueue['lock'], 'tryAcquire');
      const acquireSpy = jest.spyOn(taskQueue['lock'], 'acquire');
      const releaseSpy = jest.spyOn(taskQueue['lock'], 'release');
      const options = { signal: AbortSignal.timeout(1000) };
      const expected1 = 'result';
      const expected2 = 'result2';
      const task1 = jest.fn<() => Promise<string>>().mockResolvedValue(expected1);
      const task2 = jest.fn<() => Promise<string>>().mockResolvedValue(expected2);
      const promise1 = taskQueue.push(task1, { ...options, priority: 1 });
      const promise2 = taskQueue.push(task2);

      expect(taskQueue.size).toBe(2);
      expect((taskQueue['queue'] as Array<RunnableTask>)[0].priority).toBe(1);

      // first tryAcquire went through, but second one blocked
      expect(tryAcquireSpy).toBeCalledTimes(2);
      expect(tryAcquireSpy).nthReturnedWith(1, true);
      expect(tryAcquireSpy).nthReturnedWith(2, false);

      const actual1 = await promise1;
      await Promise.resolve(); // wait for semaphore to be released

      expect(actual1).toBe(expected1);
      expect(task1).toBeCalledTimes(1);
      expect(task1).toBeCalledWith(options);
      expect(taskQueue.size).toBe(1);
      expect(releaseSpy).toBeCalledTimes(1);

      const actual2 = await promise2;
      await Promise.resolve();

      expect(actual2).toBe(expected2);
      expect(task2).toBeCalledTimes(1);
      expect(task2).toBeCalledWith({ signal: undefined });
      expect(taskQueue.size).toBe(0);
      expect(acquireSpy).toBeCalledTimes(1);
      expect(releaseSpy).toBeCalledTimes(2);
    });
  });

  describe('poll', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const acquireSpy = jest.spyOn(taskQueue['lock'], 'acquire');
      const releaseSpy = jest.spyOn(taskQueue['lock'], 'release');
      const options = { signal: AbortSignal.timeout(1000) };
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.poll(options);

      expect(taskQueue.size).toBe(0);
      expect(acquireSpy).toBeCalledTimes(1);
      expect(acquireSpy).toBeCalledWith(options);
      expect(releaseSpy).toBeCalledTimes(1);
      expect(task).toBeCalledTimes(1);
    });

    it('should do nothing if queue is empty', async () => {
      const acquireSpy = jest.spyOn(taskQueue['lock'], 'acquire');
      await taskQueue.poll();
      expect(acquireSpy).not.toBeCalled();
    });
  });

  describe('tryPoll', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const acquireSpy = jest.spyOn(taskQueue['lock'], 'tryAcquire');
      const releaseSpy = jest.spyOn(taskQueue['lock'], 'release');
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.tryPoll();

      expect(taskQueue.size).toBe(0);
      expect(acquireSpy).toBeCalledTimes(1);
      expect(releaseSpy).toBeCalledTimes(1);
      expect(task).toBeCalledTimes(1);
    });

    it('should do nothing if cannot acquire semaphore lock', async () => {
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);
      taskQueue.push(task);

      const acquireSpy = jest.spyOn(taskQueue['lock'], 'tryAcquire');
      expect(await taskQueue.tryPoll()).toBeUndefined();
      expect(acquireSpy).nthReturnedWith(1, false);
    });

    it('should do nothing if queue is empty', async () => {
      const acquireSpy = jest.spyOn(taskQueue['lock'], 'tryAcquire');
      expect(await taskQueue.tryPoll()).toBeUndefined();
      expect(acquireSpy).not.toBeCalled();
    });
  });

  describe('pause', () => {
    it('should pause further task processing', () => {
      taskQueue.pause();
      expect(taskQueue.started).toBe(false);
    });
  });

  describe('start', () => {
    it('should start processing tasks if the queue is not paused', async () => {
      const task = jest.fn<() => Promise<void>>();
      taskQueue.pause();
      taskQueue.push(task);
      expect(taskQueue.started).toBe(false);
  
      taskQueue.start();
      await delay();

      expect(taskQueue.started).toBe(true);
      expect(task).toBeCalledTimes(1);
      expect(taskQueue.size).toBe(0);
    });

    it('should do nothing if already started', async () => {
      const acquireSpy = jest.spyOn(taskQueue['lock'], 'tryAcquire');
      taskQueue.start();
      await delay();
      expect(acquireSpy).not.toBeCalled();
    });
  });

  describe('close', () => {
    it('should wait for all tasks in the queue to complete', async () => {
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.close();
      expect(task).toBeCalledTimes(1);
      expect(taskQueue.size).toBe(0);
    });
  });
});
