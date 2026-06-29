/**
* Realm fixture — default-exports a function that accepts multiple arguments.
* Used by call() multi-parameter tests.
*/
export default function sum(...nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}
