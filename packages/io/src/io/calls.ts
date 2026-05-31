// Call dispatch constants.
// A single 32-bit integer encodes both the method (upper 8 bits) and the resource type (lower 24 bits).

// --- Masks and shift ---

/** Mask to extract the call method (upper 8 bits). */
export const CALL_MASK = 0xff000000;

/** Mask to extract the resource type (lower 24 bits). */
export const TYPE_MASK = 0x00ffffff;

/** Bit shift for call methods. */
export const CALL_SHIFT = 24;

// --- Stream/resource types (lower 24 bits) ---

export const STDIN = 1;
export const STDOUT = 2;
export const STDERR = 3;
export const FILE = 4;
export const SOCKET_TCP = 5;
export const SOCKET_UDP = 6;
export const HTTP = 7;

// --- I/O methods (upper 8 bits, shifted by 24) ---

// Stream methods
export const INPUT_STREAM_READ = 1 << 24;
export const INPUT_STREAM_BLOCKING_READ = 2 << 24;
export const INPUT_STREAM_SUBSCRIBE = 3 << 24;
export const INPUT_STREAM_DISPOSE = 4 << 24;
export const OUTPUT_STREAM_CHECK_WRITE = 5 << 24;
export const OUTPUT_STREAM_WRITE = 6 << 24;
export const OUTPUT_STREAM_BLOCKING_WRITE = 7 << 24;
export const OUTPUT_STREAM_FLUSH = 8 << 24;
export const OUTPUT_STREAM_BLOCKING_FLUSH = 9 << 24;
export const OUTPUT_STREAM_DISPOSE = 10 << 24;

// Filesystem calls
export const FS_OPEN = 20 << 24;
export const FS_CLOSE = 21 << 24;
export const FS_READ = 22 << 24;
export const FS_WRITE = 23 << 24;
export const FS_STAT = 24 << 24;
export const FS_READDIR = 25 << 24;
export const FS_MKDIR = 26 << 24;
export const FS_UNLINK = 27 << 24;
export const FS_RMDIR = 28 << 24;
export const FS_RENAME = 29 << 24;
export const FS_SYMLINK = 30 << 24;
export const FS_READLINK = 31 << 24;
export const FS_CHMOD = 32 << 24;
export const FS_UTIMES = 33 << 24;
export const FS_TRUNCATE = 34 << 24;
export const FS_LINK = 35 << 24;
export const FS_REALPATH = 36 << 24;
export const FS_MKFIFO = 37 << 24;

// HTTP calls
export const HTTP_SEND = 40 << 24;
export const HTTP_INCOMING = 41 << 24;

// Socket calls
export const SOCKET_CREATE = 45 << 24;
export const SOCKET_BIND = 46 << 24;
export const SOCKET_CONNECT = 47 << 24;
export const SOCKET_LISTEN = 48 << 24;
export const SOCKET_ACCEPT = 49 << 24;
export const SOCKET_SEND = 50 << 24;
export const SOCKET_RECV = 51 << 24;
export const SOCKET_CLOSE = 52 << 24;
export const SOCKET_RESOLVE = 53 << 24;

// Polling calls
export const POLL_READY = 60 << 24;
export const POLL_BLOCK = 61 << 24;
export const POLL_LIST = 62 << 24;
export const POLL_DISPOSE = 63 << 24;
