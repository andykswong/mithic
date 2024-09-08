import { FD, Io } from '../io/index.ts';
import { OutputStream } from '../io/streams.ts';

/** The stderr output stream. */
export function getStderr() {
  return new OutputStream({
    client: Io.provider,
    fd: FD.Stderr,
    closeOnDispose: false,
  });
}
