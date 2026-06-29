/**
 * HTTP/3 body queue compatibility export.
 *
 * H3 now uses the shared protocol-neutral `HttpBodyQueue`; this alias preserves
 * existing internal imports while H2 and H3 converge on the same stream model.
 *
 * @internal
 */

export { HttpBodyQueue as H3BodyQueue } from '../stream.ts';
