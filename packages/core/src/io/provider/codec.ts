import type { Codec } from '@mithic/commons';

/** I/O operation types. */
export const IoOp = {
  Read: 1,
  Write: 2,
  Data: 4,
  State: 5,
} as const;

export type IoOp = typeof IoOp[keyof typeof IoOp];

/** I/O operation message. */
export type IoMessage = {
  /** Op type. */
  op: IoOp,
  /** Target file (stream) descriptor. */
  fd: number,
} & ({
  op: typeof IoOp.Read,
} | {
  op: typeof IoOp.Write | typeof IoOp.Data,
  /** The message content. */
  content: Uint8Array,
} | {
  op: typeof IoOp.State,
  /** The new state. */
  state: number,
});

export const IoMessage: Codec<IoMessage> & { headerLength: number } = {
  /** Length of message header. */
  headerLength: 10,

  /**
   * Encodes an IO message.
   * format: [op (2 bytes), fd (4 bytes), len/value (4 bytes), ...bytes]
   */
  encode(message: IoMessage): Uint8Array {
    let messageLen = IoMessage.headerLength;
    switch (message.op) {
      case IoOp.Write:
      case IoOp.Data:
        messageLen += message.content.length;
        break;
    }

    const encoded = new Uint8Array(messageLen);
    const dataView = new DataView(encoded.buffer);
    dataView.setUint16(0, message.op, true);
    dataView.setUint32(2, message.fd, true);
    switch (message.op) {
      case IoOp.Write:
      case IoOp.Data:
        dataView.setUint32(6, message.content.byteLength, true);
        encoded.set(message.content, IoMessage.headerLength);
        break;
      case IoOp.State:
        dataView.setUint32(6, message.state, true);
        break;
    }
    return encoded;
  },

  /** Decodes message from binary data. */
  decode(message: Uint8Array): IoMessage | undefined {
    let messageLen = IoMessage.headerLength;
    if (message.byteLength < messageLen) { return; }

    const dataView = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const op = dataView.getUint16(0, true);
    const fd = dataView.getUint32(2, true);
    const lenVal = dataView.getUint32(6, true);

    switch (op) {
      case IoOp.Read:
        return { op, fd };
      case IoOp.Write:
      case IoOp.Data: {
        messageLen += lenVal;
        if (message.byteLength < messageLen) { return; }
        return { op, fd, content: message.subarray(IoMessage.headerLength, messageLen) };
      }
      case IoOp.State:
        return { op, fd, state: lenVal };
    }
  }
};
