import { fast } from 'app:cassette';

export default function (variant = 'same') {
  return fast({ variant, nested: new Set([1n, 2n]) });
}
