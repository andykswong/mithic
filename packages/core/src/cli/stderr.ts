import { MaybePromise } from '@mithic/commons';
import { streams, type WriteStream } from '../io/index.ts';
import { Cli } from './cli.ts';

/** The stderr output stream. */
export function getStderr(): MaybePromise<streams.OutputStream> {
  const stderr = Cli.stdio.getStderr();
  return MaybePromise.map(stderr, toOutputStream);
}

function toOutputStream(stream: WriteStream): streams.OutputStream {
  return new streams.OutputStream({ stream });
}
