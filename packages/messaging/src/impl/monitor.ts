import { createEvent, equalsOrSameString, Startable, StringEquatable, TypedEventTarget } from '@mithic/commons';
import { PubSubPeerEvent, PubSubPeerEvents, PubSubPeerState } from '../pubsub.js';

/** Default peer refresh interval in milliseconds */
export const DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS = 1000;

/** Monitor of topic peers from {@link PubSubPeerState}. */
export class PubSubPeerMonitor<Peer extends StringEquatable<Peer>>
  extends TypedEventTarget<PubSubPeerEvents<Peer>>
  implements Startable, Disposable {

  private readonly peers: Map<string, Peer[]> = new Map();
  private pollTimer = 0;

  public constructor(
    /** {@link PubSubPeerState} instance. */
    private readonly pubsub: PubSubPeerState<Peer>,
    /** Peer list refresh interval in milliseconds. */
    private readonly refreshMs = DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS,
    /** whether to start the monitor immediately. */
    start = true,
  ) {
    super();
    start && this.start();
  }

  public close(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = 0;
    this.peers.clear();
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  /** Returns if this monitor is running. */
  public get started(): boolean {
    return !!this.pollTimer;
  }

  /** Starts this monitor. */
  public start(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(this.pollPeers, this.refreshMs) as unknown as number;
    }
  }

  private pollPeers = async () => {
    await this.updateTopics();
    for (const [topic, peers] of this.peers) {
      await this.updateTopicPeers(topic, peers);
    }
  };

  /** Clean up the `peers` list based on currently subscribed topics. */
  private async updateTopics() {
    const topics = new Set(await this.pubsub.topics());
    for (const topic of this.peers.keys()) {
      if (!topics.has(topic)) {
        this.peers.delete(topic);
      }
    }
    for (const topic of topics) {
      if (!this.peers.has(topic)) {
        this.peers.set(topic, []);
      }
    }
  }

  /** Updates the `peers` list with the latest peers and emit join/leave events */
  private async updateTopicPeers(topic: string, peers: Peer[]) {
    const newPeers = Array.from(await this.pubsub.subscribers(topic));
    let existing = 0; // count of existing peers
    let leaving = 0; // count of leaving peers

    // Partition `peers` list by existing and leaving;
    // Partition `newPeers` list by existing and joining
    while (existing + leaving < peers.length) {
      let peer = peers[existing];

      // find peer from the right (not (yet) existing) side of `newPeers` list
      let newPeerx = -1;
      for (let i = existing; i < newPeers.length; ++i) {
        if (equalsOrSameString(peer, newPeers[i])) {
          newPeerx = i;
          peer = newPeers[i]; // use the new peer object
          break;
        }
      }

      if (newPeerx < 0) { // peer left, swap it to the right (leaving) side of `peers` list
        peers[existing] = peers[peers.length - leaving - 1];
        peers[peers.length - leaving - 1] = peer;
        ++leaving;
      } else { // peer remains, swap it to the left (existing) side of `newPeers` list
        newPeers[newPeerx] = newPeers[existing];
        newPeers[existing] = peer;
        ++existing;
      }
    }

    // remove leaving peers from peers list and emit event
    if (leaving) {
      const leavingPeers = peers.splice(peers.length - leaving, leaving);
      this.dispatchEvent(createEvent(PubSubPeerEvent.Leave, { topic, peers: leavingPeers }));
    }

    // add joining peers to peers list and emit event
    if (newPeers.length - existing) {
      const joiningPeers = newPeers.slice(existing);
      peers.push(...joiningPeers);
      this.dispatchEvent(createEvent(PubSubPeerEvent.Join, { topic, peers: joiningPeers }));
    }
  }
}
