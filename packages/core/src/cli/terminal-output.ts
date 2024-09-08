/**
 * The output side of a terminal.
 */
export class TerminalOutput {
  public constructor(
    public readonly isErr = false,
  ) {
  }

  public get [Symbol.toStringTag](): string {
    return TerminalOutput.name;
  }
}
