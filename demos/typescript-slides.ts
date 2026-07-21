/**
* Fino TypeScript-first performance presentation.
*
* Run with `./target/debug/fino demos/typescript-slides.ts`, then open
* `/typescript` for the audience and `/typescript-presenter` for the presenter
* console.
*/
import { App } from 'fino:net/http/app';
import { Presentation } from 'fino:ui/slides';

const app = new App({ name: 'Fino TypeScript Performance' });
const presentation = new Presentation('./demos/typescript-performance.mdx');

app.route('/typescript').mount(presentation.viewer());
app.route('/typescript-presenter').mount(presentation.presenter());

const server = app.listen({ hostname: '127.0.0.1', port: 3000 });
console.log(`Audience:  http://127.0.0.1:${server.port}/typescript`);
console.log(`Presenter: http://127.0.0.1:${server.port}/typescript-presenter`);
