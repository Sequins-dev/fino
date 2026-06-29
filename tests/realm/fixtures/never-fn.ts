/**
* Fixture: pool worker that accepts calls but never resolves them.
* Used to test RealmPool drain-timeout behavior in close().
*/
export default function never(): Promise<never> {
  return new Promise<never>(() => {});
}
