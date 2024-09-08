import { type Level, Logger } from './logger.ts';

/**
 * Emit a log message.
 * A log message has a `level` describing what kind of message is being
 * sent, a context, which is an uninterpreted string meant to help consumers
 * group similar messages, and a string containing the message text.
 */
export function log(level: Level, context: string, message: string): void {
  Logger.instance.log(level, context, message);
}
