import { TextCodec, type Codec } from '@mithic/commons';

const TEXT_CODEC = new TextCodec();

/** I/O operation types. */
export const IoOp = {
  Read: 1,
  Write: 2,
  Data: 3,
  Close: 4,
  State: 5,
  Ropen: 6,
  Wopen: 7,
} as const;

export type IoOp = typeof IoOp[keyof typeof IoOp];

/** I/O operation message. */
export type IoMessage = {
  /** Op type. */
  op: IoOp,
  /** Id or path of file to open. */
  id?: string,
  /** Target file (stream) descriptor. */
  fd?: number,
} & ({
  op: typeof IoOp.Ropen | typeof IoOp.Wopen,
  id: string,
} | {
  op: typeof IoOp.Read | typeof IoOp.Close,
  fd: number,
} | {
  op: typeof IoOp.Write | typeof IoOp.Data,
  fd: number,
  /** The message content. */
  content: Uint8Array,
} | {
  op: typeof IoOp.State,
  id?: string,
  fd: number,
  /** The new state. */
  state: number,
});

export const IoMessage: Codec<IoMessage> & { headerLength: number } = {
  /** Length of message header. */
  headerLength: 10,

  /**
   * Encodes an IO message.
   * format: [op (2 bytes), fd (4 bytes), len (4 bytes), ...bytes]
   */
  encode(message: IoMessage): Uint8Array {
    let messageLen = IoMessage.headerLength;
    switch (message.op) {
      case IoOp.Ropen:
      case IoOp.Wopen:
        messageLen += message.id.length;
        break;
      case IoOp.State:
        messageLen += 4 + (message.id?.length ?? 0);
        break;
      case IoOp.Write:
      case IoOp.Data:
        messageLen += message.content.length;
        break;
    }

    const encoded = new Uint8Array(messageLen);
    const dataView = new DataView(encoded.buffer);
    dataView.setUint16(0, message.op, true);
    dataView.setUint32(2, message.fd ?? -1, true);
    switch (message.op) {
      case IoOp.Write:
      case IoOp.Data:
        dataView.setUint32(6, message.content.byteLength, true);
        encoded.set(message.content, IoMessage.headerLength);
        break;
      case IoOp.Ropen:
      case IoOp.Wopen:
        dataView.setUint32(6, message.id.length, true);
        encoded.set(TEXT_CODEC.encode(message.id), IoMessage.headerLength);
        break;
      case IoOp.State:
        dataView.setUint32(6, 4 + (message.id?.length ?? 0), true);
        dataView.setUint32(IoMessage.headerLength, message.state, true);
        if (message.id) {
          encoded.set(TEXT_CODEC.encode(message.id), IoMessage.headerLength + 4);
        }
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
    const len = dataView.getUint32(6, true);

    switch (op) {
      case IoOp.Read:
      case IoOp.Close:
        return { op, fd };
      case IoOp.Write:
      case IoOp.Data: {
        messageLen += len;
        if (message.byteLength < messageLen) { return; }
        return { op, fd, content: message.subarray(IoMessage.headerLength, messageLen) };
      }
      case IoOp.Ropen:
      case IoOp.Wopen: {
        messageLen += len;
        if (message.byteLength < messageLen) { return; }
        return { op, fd, id: TEXT_CODEC.decode(message.subarray(IoMessage.headerLength, messageLen)) };
      }
      case IoOp.State: {
        if (len < 4) { return; }
        messageLen += len;
        const state = dataView.getUint32(IoMessage.headerLength, true);
        const id = len > 4 ? TEXT_CODEC.decode(message.subarray(IoMessage.headerLength + 4, messageLen)) : undefined;
        return id ? { op, fd, state, id } : { op, fd, state };
      }
    }
  }
};
