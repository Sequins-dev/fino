import { App } from 'fino:net/http/app';
import { Presentation } from 'fino:ui/slides';
const presentation = new Presentation('./demos/slides.mdx');
const app = new App();
app.route('/talk').mount(presentation.viewer());
const server = app.listen({
  hostname: '127.0.0.1',
  port: 0
});
console.log(server.port);
