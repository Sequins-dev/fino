import { throwFromTypedTs } from './source-map-throw.ts';

try {
  throwFromTypedTs();
} catch (err) {
  console.error(err);
}
