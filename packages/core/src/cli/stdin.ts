import { FD, Io } from '../io/index.ts';
import { InputStream } from '../io/streams.ts';

/** The stdin input stream. */
export function getStdin() {
  return new InputStream({
    client: Io.provider,
    fd: FD.Stdin,
    closeOnDispose: false,
  });
}
