/**
 * Fixture: exports the wakeFd so the parent can compare it with its own.
 */
import { wakeFd } from 'internal:async-runtime';
export default function () {
  return wakeFd;
}
