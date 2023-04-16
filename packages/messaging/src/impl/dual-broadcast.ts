/**
 * An extended BroadcastChannel that uses a second BroadcastChannel to post messages,
 * such that this instance can receive messages sent by itself.
 */
export class DualBroadcastChannel extends BroadcastChannel {
  private readonly publisher: BroadcastChannel;

  public constructor(
    /** The channel name. */
    name: string
  ) {
    super(name);
    this.publisher = new BroadcastChannel(name);
  }

  public postMessage(message: unknown): void {
    this.publisher.postMessage(message);
  }

  public close(): void {
    super.close();
    this.publisher.close();
  }
}
