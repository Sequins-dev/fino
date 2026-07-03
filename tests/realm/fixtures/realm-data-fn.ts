import { getRealmData } from 'internal:realm-bridge';

export default function realmDataFn(): string | undefined {
  return (getRealmData as () => string | undefined)();
}
