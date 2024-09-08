import { getStderr } from '../cli/stderr.ts';
import { getStdout } from '../cli/stdout.ts';
import type { OutputStream } from '../io/streams.ts';

/** A log level, describing a kind of message. */
export const Level = {
  /** Describes messages about the values of variables and the flow of control within a program. */
  Trace: 'trace',

  /** Describes messages likely to be of interest to someone debugging a program. */
  Debug: 'debug',

  /** Describes messages likely to be of interest to someone monitoring a program. */
  Info: 'info',

  /** Describes messages indicating hazardous situations. */
  Warn: 'warn',

  /** Describes messages indicating serious errors. */
  Error: 'error',

  /** Describes messages indicating fatal errors. */
  Critical: 'critical',
} as const;

export type Level = typeof Level[keyof typeof Level];

const encoder = new TextEncoder();
const levelValue: Record<Level, number> = {
  [Level.Trace]: 0,
  [Level.Debug]: 1,
  [Level.Info]: 2,
  [Level.Warn]: 3,
  [Level.Error]: 4,
  [Level.Critical]: 5
};

/** Logger that logs to output streams. */
export class StdLogger implements Logger {
  public constructor(
    /** debug output stream. */
    private readonly debug: OutputStream = getStdout(),
    /** error output stream. */
    private readonly error: OutputStream = getStderr(),
  ) { }

  /** Formats message for output to console. */
  public format(level: Level, context: string, message: string): string {
    return `[${level}] (${context}) ${message}\n`;
  }

  public log(level: Level, context: string, message: string): void {
    if (levelValue[level] < levelValue[Logger.level]) {
      return;
    }

    const output = encoder.encode(this.format(level, context, message));
    let stream;
    switch (level) {
      case Level.Warn:
      case Level.Error:
      case Level.Critical:
        stream = this.error;
        break;
      case Level.Trace:
      case Level.Debug:
      case Level.Info:
      default:
        stream = this.debug;
        break;
    }

    for (let offset = 0; offset < output.byteLength;) {
      const writeLen = Math.min(output.byteLength - offset, Number(stream.checkWrite()));
      stream.write(output.subarray(offset, offset + writeLen));
      offset += writeLen;
    }
  }
}

/** The Logger. */
export interface Logger {
  /** Logs a message. */
  log(level: Level, context: string, message: string): void;
}

let logger: Logger;

export const Logger = {
  /** The logger instance. */
  get instance(): Logger {
    return (logger = logger || new StdLogger());
  },
  set instance(instance: Logger) {
    logger = instance;
  },

  /** The logging level to use. */
  level: Level.Warn as Level,
};
