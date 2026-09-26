/**
 * Draft presentation for the layered-core architecture talk.
 *
 * Run with `./target/debug/fino demos/layered-core-slides.ts`, then open
 * `/talk` for the audience view and `/control` for the presenter console.
 */
import { App } from 'fino:net/http/app';
import { Presentation } from 'fino:ui/slides';

const app = new App({ name: 'What if everything was TypeScript?' });
const presentation = new Presentation('./demos/layered-core.mdx');

app.route('/talk').mount(presentation.viewer());
app.route('/control').mount(presentation.presenter());

const server = app.listen({
  hostname: '127.0.0.1',
  port: 3000,
});

console.log(`Audience:  http://127.0.0.1:${server.port}/talk`);
console.log(`Presenter: http://127.0.0.1:${server.port}/control`);
