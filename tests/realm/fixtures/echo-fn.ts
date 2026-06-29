/**
* Realm fixture — default-exports a function that echoes its input.
* Used by call() tests.
*/
export default function echo(input: unknown): unknown {
  return input;
}
