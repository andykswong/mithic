import { ContentId } from '@mithic/commons';

/** Metadata of an event. */
export interface EventMeta<K = ContentId> {
  /** Event type. */
  readonly type: string;

  /** Aggregate root link. */
  readonly root?: K;

  /** Dependent event links. */
  readonly link?: readonly K[];

  /** Issue time of the event. */
  readonly time?: number;
}
