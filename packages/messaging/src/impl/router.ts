import { MaybePromise, type StringMatcher } from '@mithic/commons';
import type { Message } from '../message.ts';
import type { MessagingService, PeerPresence, RequestReply } from '../service.ts';
import type { MessageHandler, RequestOptions, PeerId } from '../types.ts';
import { invalidRequest, unsupported } from '../utils/index.ts';

/** {@link MessagingService} that routes to different {@link MessagingService} by topic. */
export class RoutingMessagingService implements MessagingService, RequestReply, PeerPresence {
  private readonly routes: (readonly [StringMatcher, MessagingService])[];

  public constructor(routes: Iterable<readonly [StringMatcher, MessagingService]> = []) {
    this.routes = [...routes];
  }

  public send(topic: string, message: Message): MaybePromise<void> {
    const service = this.getService(topic) ?? unsupported();
    return service.send(topic, message);
  }

  public subscribe(topics: Iterable<string>, handler: MessageHandler): MaybePromise<void> {
    const subscribed = new Set<string>();
    const results: MaybePromise<void>[] = [];

    for (const route of this.routes) {
      const matchedTopics = [];
      for (const topic of topics) {
        const match = route[0][Symbol.match](topic) && !subscribed.has(topic);
        if (match) {
          matchedTopics.push(topic);
          subscribed.add(topic);
        }
      }
      if (matchedTopics.length) {
        results.push(route[1].subscribe(matchedTopics, handler));
      }
    }

    return MaybePromise.map(MaybePromise.all(results), asVoid);
  }

  public request(topic: string, request: Message, options?: RequestOptions): MaybePromise<Message[]> {
    const service = this.getService(topic, isRequestReply) ?? unsupported();
    return service.request(topic, request, options);
  }

  public reply(request: Message, reply: Message): MaybePromise<void> {
    const topic = request.topic() ?? invalidRequest();
    const service = this.getService(topic, isRequestReply) ?? unsupported();
    return service.reply(request, reply);
  }

  public listSubscribers(topic: string): MaybePromise<PeerId[]> {
    const service = this.getService(topic, isPresenceAware) ?? unsupported();
    return service.listSubscribers(topic);
  }

  /** Adds a new topic route to {@link MessagingService}. */
  public route(matcher: StringMatcher, service: MessagingService) {
    this.routes.push([matcher, service]);
  }

  private getService<M extends MessagingService>(
    topic: string, filter?: (service: MessagingService) => service is M
  ): M | undefined {
    for (const route of this.routes) {
      const match = route[0][Symbol.match](topic);
      if (match && (!filter || filter(route[1]))) {
        return route[1] as M;
      }
    }
  }
}

function isRequestReply(service: MessagingService): service is MessagingService & RequestReply {
  return !!service.request && !!service.reply;
}

function isPresenceAware(service: MessagingService): service is MessagingService & PeerPresence {
  return !!service.listSubscribers;
}

function asVoid() { }
