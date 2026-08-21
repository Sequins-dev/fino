import { Realm } from 'fino:realm';

export default function nestedRealmGuest(): string {
  try {
    new Realm({ entry: import.meta.url });
    return 'allowed';
  } catch (error) {
    return String(error);
  }
}
