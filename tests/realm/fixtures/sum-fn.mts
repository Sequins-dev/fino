/**
 * Pool worker: sums all numeric arguments.
 */
export default function sum(...args: number[]): number {
  return args.reduce((a, b) => a + b, 0);
}
