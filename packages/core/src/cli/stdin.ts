import { MaybePromise } from '@mithic/commons';
import { streams, type ReadStream } from '../io/index.ts';
import { Cli } from './cli.ts';

/** The stdin input stream. */
export function getStdin(): MaybePromise<streams.InputStream> {
  const stdin = Cli.stdio.getStdin();
  return MaybePromise.map(stdin, toInputStream);
}

function toInputStream(stream: ReadStream): streams.InputStream {
  return new streams.InputStream({ stream });
}
