import { ContentId } from '@mithic/commons';

/** Default page size for queries. */
export const DEFAULT_QUERY_PAGE_SIZE = 64;

/** Default text encoder. */
export const TEXT_ENCODER = new TextEncoder();

/** Default key encoder function. */
export const DEFAULT_KEY_ENCODER = <Id>(key: Id) => (key as unknown as ContentId)?.bytes ?? TEXT_ENCODER.encode(`${key}`);

/** Default regex for splitting event types. */
export const DEFAULT_EVENT_TYPE_SEPARATOR = /[._#$\-/]+/g;
