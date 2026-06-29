/**
* Realm fixture — throws a TypeError with a known message.
* Used to verify that Error subclass name and message survive inter-realm serialization.
*/
export default function throwTypeError(_input: unknown): never {
  throw new TypeError('expected a string, got something else');
}
