import {
  IoStreamClientProvider, type IoStreamClientProviderOptions, type SyncReadStream, type SyncWriteStream
} from '../../types.ts';
import type { StdioProvider } from '../provider.ts';

/** Synchronous {@link StdioProvider} based on a {@link IoStreamClientProvider}. */
export class SyncStdioProvider implements StdioProvider {
  private readonly client: IoStreamClientProvider;

  public constructor(options?: IoStreamClientProviderOptions) {
    this.client = new IoStreamClientProvider(options);
  }

  public getStdin(): SyncReadStream {
    return this.client.openReadStream('/dev/stdin');
  }

  public getStdout(): SyncWriteStream {
    return this.client.openWriteStream('/dev/stdout');
  }

  public getStderr(): SyncWriteStream {
    return this.client.openWriteStream('/dev/stderr');
  }
}
