/**
 * Pure file constants shared by local and remote filesystem implementations.
 *
 * Keeping these values separate from the libc bindings lets a facade-backed
 * filesystem expose the ordinary `fino:file` constants without opening libc,
 * importing the runtime loop, or performing host I/O.
 *
 * ```ts no_run
 * import { O_CREAT, O_TRUNC, O_WRONLY } from 'internal:file/constants';
 *
 * const createTruncated = O_WRONLY | O_CREAT | O_TRUNC;
 * ```
 *
 * @internal
 */
import { os } from 'internal:process';

const isDarwin = os === 'darwin';

/** Read-only flag for `open(2)`. */
export const O_RDONLY = 0;
/** Write-only flag for `open(2)`. */
export const O_WRONLY = 1;
/** Read-write flag for `open(2)`. */
export const O_RDWR = 2;
/** Platform-specific create flag for `open(2)`. */
export const O_CREAT = isDarwin ? 512 : 64;
/** Platform-specific truncate flag for `open(2)`. */
export const O_TRUNC = isDarwin ? 1024 : 512;
/** Platform-specific append flag for `open(2)`. */
export const O_APPEND = isDarwin ? 8 : 1024;
/** Platform-specific exclusive-create flag for `open(2)`. */
export const O_EXCL = isDarwin ? 2048 : 128;

/** POSIX file-type mask. */
export const S_IFMT = 61440;
/** POSIX regular-file type bit. */
export const S_IFREG = 32768;
/** POSIX directory type bit. */
export const S_IFDIR = 16384;
/** POSIX symbolic-link type bit. */
export const S_IFLNK = 40960;
/** POSIX socket type bit. */
export const S_IFSOCK = 49152;
/** POSIX FIFO type bit. */
export const S_IFIFO = 4096;
/** POSIX block-device type bit. */
export const S_IFBLK = 24576;
/** POSIX character-device type bit. */
export const S_IFCHR = 8192;

/** Seek relative to the start, current offset, or end. */
export const SEEK_SET = 0;
/** Seek relative to the current offset. */
export const SEEK_CUR = 1;
/** Seek relative to the end. */
export const SEEK_END = 2;

/** Existence, read, write, and execute checks for `access(2)`. */
export const F_OK = 0;
/** Read-permission check for `access(2)`. */
export const R_OK = 4;
/** Write-permission check for `access(2)`. */
export const W_OK = 2;
/** Execute-permission check for `access(2)`. */
export const X_OK = 1;

/** Unknown directory-entry type. */
export const DT_UNKNOWN = 0;
/** FIFO directory-entry type. */
export const DT_FIFO = 1;
/** Character-device directory-entry type. */
export const DT_CHR = 2;
/** Directory directory-entry type. */
export const DT_DIR = 4;
/** Block-device directory-entry type. */
export const DT_BLK = 6;
/** Regular-file directory-entry type. */
export const DT_REG = 8;
/** Symbolic-link directory-entry type. */
export const DT_LNK = 10;
/** Socket directory-entry type. */
export const DT_SOCK = 12;
