import { MaybePromise } from '@mithic/commons';
import { streams, type WriteStream } from '../io/index.ts';
import { Cli } from './cli.ts';

/** The stdout output stream. */
export function getStdout(): MaybePromise<streams.OutputStream> {
  const stdout = Cli.stdio.getStdout();
  return MaybePromise.map(stdout, toOutputStream);
}

function toOutputStream(stream: WriteStream): streams.OutputStream {
  return new streams.OutputStream({ stream });
}
