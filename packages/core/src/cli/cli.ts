import { WebStreamStdioProvider } from './impl/webstreams.ts';
import type { StdioProvider } from './provider.ts';

let stdio: StdioProvider;

/** The CLI module. */
export const Cli = {
  /** The underlying stdio stream provider. */
  get stdio(): StdioProvider {
    if (!stdio) {
      stdio = new WebStreamStdioProvider();
    }
    return stdio;
  },
  set stdio(value: StdioProvider) {
    stdio = value;
  },
};
