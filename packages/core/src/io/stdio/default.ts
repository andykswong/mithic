import { Level } from '../../logging/index.ts';
import { log } from '../../logging/logging.ts';

const stdoutDecoder = new TextDecoder();
const stderrDecoder = new TextDecoder();

/** A closed ReadableStream, as stdin is not supported in browser. */
export const getStdin = () => new ReadableStream({ start: (controller) => controller.close() });

/** WritableStream to log. */
export const getStdout = () => new WritableStream({
  write(chunk) {
    log(Level.Info, 'stdout', stdoutDecoder.decode(chunk, { stream: true }));
  },
});

/** WritableStream to error log. */
export const getStderr = () => new WritableStream({
  write(chunk) {
    log(Level.Error, 'stderr', stderrDecoder.decode(chunk, { stream: true }));
  },
});
