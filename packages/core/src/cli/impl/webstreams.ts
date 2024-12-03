import { getStdin, getStdout, getStderr } from '#io/stdio';
import { WebReadStream, WebWriteStream, type ReadStream, type WriteStream } from '../../types.ts';
import type { StdioProvider } from '../provider.ts';

/** Web Streams API based {@link StdioProvider}. */
export class WebStreamStdioProvider implements StdioProvider {
  public getStdin(): ReadStream {
    return new WebReadStream(getStdin());
  }

  public getStdout(): WriteStream {
    return new WebWriteStream(getStdout());
  }

  public getStderr(): WriteStream {
    return new WebWriteStream(getStderr());
  }
}
