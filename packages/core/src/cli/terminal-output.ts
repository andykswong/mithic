/**
 * The output side of a terminal.
 */
export class TerminalOutput {
  /** Whether this is an error output. */
  public readonly isErr: boolean;

  public constructor(
    /** Whether this is an error output. */
    isErr = false,
  ) {
    this.isErr = isErr;
  }

  public get [Symbol.toStringTag](): string {
    return TerminalOutput.name;
  }
}
