import { FD, Io } from '../io/index.ts';
import { OutputStream } from '../io/streams.ts';

/** The stdout output stream. */
export function getStdout() {
  return new OutputStream({
    client: Io.provider,
    fd: FD.Stdout,
    closeOnDispose: false,
  });
}
