/** Value type for Redis */
export type RedisValueType<UseBuffer = false> = UseBuffer extends true ? Buffer : string;
