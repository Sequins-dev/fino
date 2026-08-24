import { chdir, cwd } from 'fino:process';

export default function realmCwd(path: string): string {
  chdir(path);
  return cwd();
}
