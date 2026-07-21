/**
* Fino FFI performance presentation.
*
* Run with `./target/debug/fino demos/ffi-slides.ts`, then open `/ffi` for the
* audience and `/ffi-presenter` for the presenter console.
*/
import { App } from 'fino:net/http/app';
import { Presentation } from 'fino:ui/slides';

const app = new App({ name: 'Fino FFI Performance' });
const presentation = new Presentation('./demos/ffi-performance.mdx');

app.route('/ffi').mount(presentation.viewer());
app.route('/ffi-presenter').mount(presentation.presenter());

const server = app.listen({ hostname: '127.0.0.1', port: 3000 });
console.log(`Audience:  http://127.0.0.1:${server.port}/ffi`);
console.log(`Presenter: http://127.0.0.1:${server.port}/ffi-presenter`);
