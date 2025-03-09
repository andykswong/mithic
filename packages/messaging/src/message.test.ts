
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Message, type MessageRecord } from './message.ts';

const TOPIC = 'topic';
const CONTENT_TYPE = 'application/json';
const DATA = new Uint8Array([1, 2, 3]);
const METADATA: MessageRecord['metadata'] = [['key', 'value']];

describe('Message', () => {
  describe('from', () => {
    it('should create a message from a record', () => {
      const record: MessageRecord = {
        topic: TOPIC,
        contentType: CONTENT_TYPE,
        data: DATA,
        metadata: METADATA,
      };
      const message = Message.from(record);
      assert.strictEqual(message.topic(), TOPIC);
      assert.strictEqual(message.contentType(), CONTENT_TYPE);
      assert.deepStrictEqual(message.data(), record.data);
      assert.deepStrictEqual(message.metadata(), record.metadata);
    });
  });

  describe('toRecord', () => {
    it('should create a record from a message', () => {
      const message = new Message(DATA, TOPIC);
      message.setContentType(CONTENT_TYPE);
      message.setMetadata(METADATA);

      const record = message.toRecord();
      assert.strictEqual(record.topic, TOPIC);
      assert.strictEqual(record.contentType, CONTENT_TYPE);
      assert.deepStrictEqual(record.data, DATA);
      assert.deepStrictEqual(record.metadata, METADATA);
    });
  });

  describe('setData', () => {
    it('should set the data of the message', () => {
      const message = new Message(DATA, TOPIC);
      const newData = new Uint8Array([4, 5, 6]);
      message.setData(newData);
      assert.deepStrictEqual(message.data(), newData);
    });
  });

  describe('addMetadata', () => {
    it('should add metadata to the message', () => {
      const message = new Message(DATA, TOPIC);
      message.addMetadata('key', 'value');
      assert.deepStrictEqual(message.metadata(), METADATA);
    });
  });

  describe('setMetadata', () => {
    it('should set metadata of the message', () => {
      const message = new Message(DATA, TOPIC);
      message.setMetadata(METADATA);
      assert.deepStrictEqual(message.metadata(), METADATA);
    });
  });

  describe('removeMetadata', () => {
    it('should remove metadata from the message', () => {
      const message = new Message(DATA, TOPIC);
      message.setMetadata(METADATA);
      message.removeMetadata('key');
      assert.deepStrictEqual(message.metadata(), []);
    });
  });
});
