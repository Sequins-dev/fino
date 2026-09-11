import { DiskFileSystem } from 'fino:file';
import { Socket } from 'fino:net/socket';
import { env, pid } from 'fino:process';

export default async function () {
  if (Object.keys(env).length || pid !== 1) throw new Error('escaped process metadata');
  const results: string[] = [];
  try {
    const handle = await new DiskFileSystem().open('/etc/passwd');
    await handle.close();
    results.push('escaped file');
  } catch (error) {
    results.push(String(error));
  }
  try {
    const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    listener.close();
    results.push('escaped socket');
  } catch (error) {
    results.push(String(error));
  }
  return results;
}
