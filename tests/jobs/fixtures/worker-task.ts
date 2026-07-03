/**
* Pool worker definition: a Task tree default-exported so the realm
* bootstrap turns it into a job dispatcher automatically.
*/
import { task } from 'fino:task';
import { durableTask } from 'fino:task/durable';
import { DiskFileSystem } from 'fino:file';

export default task({
  name: 'pool-root',
  run: async () => 'root-ok',
  children: [
    task({
      name: 'pool-double',
      run: async (input: { v: number }) => input.v * 2
    }),
    task({
      name: 'pool-marker-flaky',
      run: async (input: { marker: string }) => {
        const fs = new DiskFileSystem();
        try {
          await fs.stat(input.marker);
          return 'second-try';
        } catch {
          await fs.writeFile(input.marker, 'seen');
          throw new Error('first try fails');
        }
      }
    }),
    durableTask({
      name: 'pool-durable-nap',
      run: async (_input: null, ctx) => {
        const first = await ctx.step('first', () => 'first');
        await ctx.sleep('nap', 150);
        const second = await ctx.step('second', () => 'second');
        return `${first},${second}`;
      }
    })
  ]
});
