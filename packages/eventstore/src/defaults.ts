import { ContentId } from '@mithic/commons';
import { base64 } from 'multiformats/bases/base64';

/** Default page size for batch operations. */
export const DEFAULT_BATCH_SIZE = 64;

/** Default key encoder function. */
export const DEFAULT_KEY_ENCODER = <K>(key: K) => (key as ContentId).toString(base64);

/** Default regex for splitting event types. */
export const DEFAULT_EVENT_TYPE_SEPARATOR = /[._#$\-/]+/g;
