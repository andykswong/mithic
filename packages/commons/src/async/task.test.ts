import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { dispose } from '../lifecycle.ts';
import { delay } from './delay.ts';
import { type RunnableTask, TaskQueue } from './task.ts';
import { AtomicSemaphore } from './semaphore.ts';

describe('TaskQueue', () => {
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
      assert.strictEqual(taskQueue['paused'], false);
      assert.strictEqual(taskQueue.started, true);
    });
  });

  describe('asyncDispose', () => {
    it('should wait for all tasks in the queue to complete', async () => {
      const task = mock.fn<() => Promise<void>>();
      taskQueue.push(task);

      await dispose(taskQueue);
      assert.strictEqual(task.mock.callCount(), 1);
      assert.strictEqual(taskQueue.size, 0);
    });
  });

  describe('push', () => {
    it('should add a task to the queue', async () => {
      const expected = 'result';
      const task = mock.fn<() => Promise<string>>(async () => {
        assert.strictEqual(taskQueue.pending, 1);
        return expected;
      });
      const promise = taskQueue.push(task);

      assert.strictEqual(taskQueue.size, 1);

      const actual = await promise;
      assert.strictEqual(actual, expected);
      assert.strictEqual(taskQueue.size, 0);
    });

    it('should queue tasks to be executed with semaphore locking', async () => {
      const waitSpy = mock.method(taskQueue['semaphore'], 'wait');
      const waitAsyncSpy = mock.method(taskQueue['semaphore'], 'waitAsync');
      const notifySpy = mock.method(taskQueue['semaphore'], 'notify');
      const timeoutMs = 1000;
      const expected1 = 'result';
      const expected2 = 'result2';
      const task1 = mock.fn<() => Promise<string>>(async () => expected1);
      const task2 = mock.fn<() => Promise<string>>(async () => expected2);
      const promise1 = taskQueue.push(task1, { priority: 1, timeoutMs });
      const promise2 = taskQueue.push(task2);

      assert.strictEqual(taskQueue.size, 2);
      assert.strictEqual((taskQueue['queue'] as Array<RunnableTask>)[0].priority, 1);

      // first wait went through, but second one blocked
      assert.strictEqual(waitSpy.mock.callCount(), 2);
      assert.strictEqual(waitSpy.mock.calls[0].result, true);
      assert.strictEqual(waitSpy.mock.calls[1].result, false);

      const actual1 = await promise1;
      await Promise.resolve(); // wait for semaphore to be released

      assert.strictEqual(actual1, expected1);
      assert.strictEqual(task1.mock.callCount(), 1);
      assert.deepStrictEqual(task1.mock.calls[0].arguments, [timeoutMs]);
      assert.strictEqual(taskQueue.size, 1);
      assert.strictEqual(notifySpy.mock.callCount(), 1);

      const actual2 = await promise2;
      await Promise.resolve();

      assert.strictEqual(actual2, expected2);
      assert.strictEqual(task2.mock.callCount(), 1);
      assert.deepStrictEqual(task2.mock.calls[0].arguments, [TIMEOUT]);
      assert.strictEqual(taskQueue.size, 0);
      assert.strictEqual(waitAsyncSpy.mock.callCount(), 1);
      assert.strictEqual(notifySpy.mock.callCount(), 2);
    });
  });

  describe('poll', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const waitAsyncSpy = mock.method(taskQueue['semaphore'], 'waitAsync');
      const notifySpy = mock.method(taskQueue['semaphore'], 'notify');
      const timeout = 1000;
      const task = mock.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.poll(timeout);

      assert.strictEqual(taskQueue.size, 0);
      assert.strictEqual(waitAsyncSpy.mock.callCount(), 1);
      assert.deepStrictEqual(waitAsyncSpy.mock.calls[0].arguments, [1, timeout]);
      assert.strictEqual(notifySpy.mock.callCount(), 1);
      assert.strictEqual(task.mock.callCount(), 1);
    });

    it('should do nothing if queue is empty', async () => {
      const waitAsyncSpy = mock.method(taskQueue['semaphore'], 'waitAsync');
      await taskQueue.poll();
      assert.strictEqual(waitAsyncSpy.mock.callCount(), 0);
    });
  });

  describe('pollOnce', () => {
    it('should wait for the top task in the queue to complete with semaphore lock', async () => {
      taskQueue.pause();

      const waitSpy = mock.method(taskQueue['semaphore'], 'wait');
      const notifySpy = mock.method(taskQueue['semaphore'], 'notify');
      const task = mock.fn<() => Promise<void>>();
      taskQueue.push(task);

      await taskQueue.pollOnce();

      assert.strictEqual(taskQueue.size, 0);
      assert.strictEqual(waitSpy.mock.callCount(), 1);
      assert.strictEqual(notifySpy.mock.callCount(), 1);
      assert.strictEqual(task.mock.callCount(), 1);
    });

    it('should do nothing if cannot acquire semaphore lock', async () => {
      const task = mock.fn<() => Promise<void>>();
      taskQueue.push(task);
      taskQueue.push(task);

      const waitSpy = mock.method(taskQueue['semaphore'], 'wait');
      assert.strictEqual(await taskQueue.pollOnce(), undefined);
      assert.strictEqual(waitSpy.mock.calls[0].result, false);
    });

    it('should do nothing if queue is empty', async () => {
      const waitSpy = mock.method(taskQueue['semaphore'], 'wait');
      assert.strictEqual(await taskQueue.pollOnce(), undefined);
      assert.strictEqual(waitSpy.mock.callCount(), 0);
    });
  });

  describe('pause', () => {
    it('should pause further task processing', () => {
      taskQueue.pause();
      assert.strictEqual(taskQueue.started, false);
    });
  });

  describe('start', () => {
    it('should start processing tasks if the queue is not paused', async () => {
      const task = mock.fn<() => Promise<void>>();
      taskQueue.pause();
      taskQueue.push(task);
      assert.strictEqual(taskQueue.started, false);
  
      taskQueue.start();
      await delay();

      assert.strictEqual(taskQueue.started, true);
      assert.strictEqual(task.mock.callCount(), 1);
      assert.strictEqual(taskQueue.size, 0);
    });

    it('should do nothing if already started', async () => {
      const waitSpy = mock.method(taskQueue['semaphore'], 'wait');
      taskQueue.start();
      await delay();
      assert.strictEqual(waitSpy.mock.callCount(), 0);
    });
  });
});
