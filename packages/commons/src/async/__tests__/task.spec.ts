import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { dispose } from '../../lifecycle.ts';
import { delay } from '../delay.ts';
import { type RunnableTask, TaskQueue } from '../task.ts';
import { AtomicSemaphore } from '../semaphore.ts';

describe(TaskQueue.name, () => {
  const TIMEOUT = 1000;
  let semaphore: AtomicSemaphore;
  let taskQueue: TaskQueue;

  beforeEach(() => {
    semaphore = new AtomicSemaphore();
    semaphore.notify(1);
    taskQueue = new TaskQueue({ semaphore, timeoutMs: TIMEOUT });
  });

  describe('constructor', () => {
    it('should initialize paused state to false by default', () => {
      expect(taskQueue['paused']).toBe(false);
      expect(taskQueue.started).toBe(true);
    });
  });

  describe('asyncDispose', () => {
    it('should wait for all tasks in the queue to complete', async () => {
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await dispose(taskQueue);
      expect(task).toBeCalledTimes(1);
      expect(taskQueue.size).toBe(0);
    });
  });

  describe('push', () => {
    it('should add a task to the queue', async () => {
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
      const waitSpy = jest.spyOn(taskQueue['semaphore'], 'wait');
      const waitAsyncSpy = jest.spyOn(taskQueue['semaphore'], 'waitAsync');
      const notifySpy = jest.spyOn(taskQueue['semaphore'], 'notify');
      const timeoutMs = 1000;
      const expected1 = 'result';
      const expected2 = 'result2';
      const task1 = jest.fn<() => Promise<string>>().mockResolvedValue(expected1);
      const task2 = jest.fn<() => Promise<string>>().mockResolvedValue(expected2);
      const promise1 = taskQueue.push(task1, { priority: 1, timeoutMs });
      const promise2 = taskQueue.push(task2);

      expect(taskQueue.size).toBe(2);
      expect((taskQueue['queue'] as Array<RunnableTask>)[0].priority).toBe(1);

      // first wait went through, but second one blocked
      expect(waitSpy).toBeCalledTimes(2);
      expect(waitSpy.mock.results[0].value).toBe(true);
      expect(waitSpy.mock.results[1].value).toBe(false);

      const actual1 = await promise1;
      await Promise.resolve(); // wait for semaphore to be released

      expect(actual1).toBe(expected1);
      expect(task1).toBeCalledTimes(1);
      expect(task1).toBeCalledWith(timeoutMs);
      expect(taskQueue.size).toBe(1);
      expect(notifySpy).toBeCalledTimes(1);

      const actual2 = await promise2;
      await Promise.resolve();

      expect(actual2).toBe(expected2);
      expect(task2).toBeCalledTimes(1);
      expect(task2).toBeCalledWith(TIMEOUT);
      expect(taskQueue.size).toBe(0);
      expect(waitAsyncSpy).toBeCalledTimes(1);
      expect(notifySpy).toBeCalledTimes(2);
    });
  });

  describe('poll', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const waitAsyncSpy = jest.spyOn(taskQueue['semaphore'], 'waitAsync');
      const notifySpy = jest.spyOn(taskQueue['semaphore'], 'notify');
      const timeout = 1000;
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.poll(timeout);

      expect(taskQueue.size).toBe(0);
      expect(waitAsyncSpy).toBeCalledTimes(1);
      expect(waitAsyncSpy).toBeCalledWith(1, timeout);
      expect(notifySpy).toBeCalledTimes(1);
      expect(task).toBeCalledTimes(1);
    });

    it('should do nothing if queue is empty', async () => {
      const waitAsyncSpy = jest.spyOn(taskQueue['semaphore'], 'waitAsync');
      await taskQueue.poll();
      expect(waitAsyncSpy).not.toBeCalled();
    });
  });

  describe('pollOnce', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const waitSpy = jest.spyOn(taskQueue['semaphore'], 'wait');
      const notifySpy = jest.spyOn(taskQueue['semaphore'], 'notify');
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.pollOnce();

      expect(taskQueue.size).toBe(0);
      expect(waitSpy).toBeCalledTimes(1);
      expect(notifySpy).toBeCalledTimes(1);
      expect(task).toBeCalledTimes(1);
    });

    it('should do nothing if cannot acquire semaphore lock', async () => {
      const task = jest.fn<() => Promise<void>>();
      taskQueue.push(task);
      taskQueue.push(task);

      const waitSpy = jest.spyOn(taskQueue['semaphore'], 'wait');
      expect(await taskQueue.pollOnce()).toBeUndefined();
      expect(waitSpy.mock.results[0].value).toBe(false);
    });

    it('should do nothing if queue is empty', async () => {
      const waitSpy = jest.spyOn(taskQueue['semaphore'], 'wait');
      expect(await taskQueue.pollOnce()).toBeUndefined();
      expect(waitSpy).not.toBeCalled();
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
      const waitSpy = jest.spyOn(taskQueue['semaphore'], 'wait');
      taskQueue.start();
      await delay();
      expect(waitSpy).not.toBeCalled();
    });
  });
});
