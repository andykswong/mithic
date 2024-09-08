import { Readable, Writable } from 'node:stream';

/** stdin ReadableStream. */
export const getStdin = () => Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

/** stdout WritableStream. */
export const getStdout = () => Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;

/** stderr WritableStream. */
export const getStderr = () => Writable.toWeb(process.stderr) as WritableStream<Uint8Array>;
