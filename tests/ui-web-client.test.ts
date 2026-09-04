import { describe, it } from 'fino:test/test';
import { CLIENT_SOURCE } from '../js/internal/ui/web/client.ts';

/**
 * A DOM subset sufficient to drive the bundled browser runtime.
 *
 * The runtime is a baked script string rather than an importable module, so it
 * is evaluated here against this stub. Only the surface the runtime actually
 * touches is implemented; anything else should fail loudly rather than silently
 * pretend to work.
 */
function makeDom() {
  const counts = { created: 0, inserted: 0, removed: 0 };

  class Node {
    nodeType = 1;
    parentNode: any = null;
    childNodes: any[] = [];
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] ?? null;
    }
    get nextSibling() {
      const siblings = this.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get isConnected() {
      let node: any = this;
      while (node.parentNode !== null) node = node.parentNode;
      return node === doc;
    }
    contains(other: any) {
      let node = other;
      while (node !== null) {
        if (node === this) return true;
        node = node.parentNode;
      }
      return false;
    }
    #detach(child: any) {
      if (child.parentNode === null) return;
      const siblings = child.parentNode.childNodes;
      const at = siblings.indexOf(child);
      if (at >= 0) siblings.splice(at, 1);
      child.parentNode = null;
    }
    insertBefore(child: any, reference: any) {
      counts.inserted++;
      this.#detach(child);
      const at = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
      this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
      child.parentNode = this;
      return child;
    }
    appendChild(child: any) {
      return this.insertBefore(child, null);
    }
    removeChild(child: any) {
      counts.removed++;
      this.#detach(child);
      return child;
    }
    append(...children: any[]) {
      for (const child of children) {
        if (child instanceof Fragment) this.append(...[...child.childNodes]);
        else this.appendChild(child);
      }
    }
    replaceChildren(...children: any[]) {
      for (const child of [...this.childNodes]) this.removeChild(child);
      this.append(...children);
    }
  }

  class Text extends Node {
    nodeType = 3;
    data: string;
    constructor(data: string) {
      super();
      this.data = data;
    }
  }

  class Fragment extends Node {
    nodeType = 11;
  }

  class Element extends Node {
    tagName: string;
    attributes = new Map<string, string>();
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    disabled = false;
    scrollTop = 0;
    constructor(tagName: string) {
      super();
      this.tagName = tagName;
    }
    get id() {
      return this.attributes.get('id') ?? '';
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
      if (name.startsWith('data-')) {
        const key = name
          .slice(5)
          .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        this.dataset[key] = value;
      }
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    focus() {
      doc.activeElement = this;
    }
    get form() {
      let node: any = this.parentNode;
      while (node !== null) {
        if (node instanceof HTMLFormElement) return node;
        node = node.parentNode;
      }
      return null;
    }
    closest(selector: string) {
      if (selector !== 'form[data-fi-action]') throw new Error(`Unsupported closest: ${selector}`);
      let node: any = this;
      while (node !== null) {
        if (node instanceof HTMLFormElement && node.dataset.fiAction !== undefined) return node;
        node = node.parentNode;
      }
      return null;
    }
    querySelectorAll(selector: string) {
      const match = /^\[([a-z-]+)\]$/.exec(selector);
      if (match === null) throw new Error(`Unsupported selector: ${selector}`);
      const out: any[] = [];
      const walk = (node: any) => {
        if (node instanceof Element && node.attributes.has(match[1]!)) out.push(node);
        for (const child of node.childNodes) walk(child);
      };
      walk(this);
      return out;
    }
    descendants(): any[] {
      const out: any[] = [];
      const walk = (node: any) => {
        for (const child of node.childNodes) {
          out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
  }

  class Input extends Element {
    value = '';
    checked = false;
    selectionStart = 0;
    selectionEnd = 0;
    type = 'text';
    name = '';
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }

  class HTMLFormElement extends Element {
    method = 'POST';
    action = '';
    get elements() {
      const controls: any = this.descendants().filter(
        (node) => node instanceof Input || node instanceof Button,
      );
      controls.namedItem = (name: string) =>
        controls.find((control: any) => (control.name || control.getAttribute('name')) === name) ??
        null;
      return controls;
    }
  }

  class Button extends Element {
    type = 'submit';
    name = '';
    value = '';
  }

  const doc: any = Object.assign(new Element('#document'), {
    nodeType: 9,
    readyState: 'complete',
    activeElement: null as any,
    listeners: new Map<string, any[]>(),
    createElement(tagName: string) {
      counts.created++;
      if (tagName === 'form') return new HTMLFormElement(tagName);
      if (tagName === 'input' || tagName === 'textarea') return new Input(tagName);
      if (tagName === 'button') return new Button(tagName);
      return new Element(tagName);
    },
    createTextNode(data: string) {
      counts.created++;
      return new Text(data);
    },
    createDocumentFragment() {
      return new Fragment();
    },
    getElementById(id: string) {
      return doc.descendants().find((node: any) => node instanceof Element && node.id === id) ?? null;
    },
    addEventListener(type: string, handler: any) {
      const list = doc.listeners.get(type) ?? [];
      list.push(handler);
      doc.listeners.set(type, list);
    },
    dispatch(type: string, event: any) {
      for (const handler of doc.listeners.get(type) ?? []) handler(event);
    },
  });
  doc.parentNode = null;

  const emitted: any[] = [];
  const confirmations: string[] = [];
  let confirmAnswer = true;
  const fakeGlobal: any = {
    dispatchEvent(event: any) {
      emitted.push(event);
      return true;
    },
    confirm(message: string) {
      confirmations.push(message);
      return confirmAnswer;
    },
  };
  const setConfirmAnswer = (answer: boolean) => {
    confirmAnswer = answer;
  };

  class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  }

  class FormData {
    #entries: Array<[string, string]> = [];
    constructor(form?: any, submitter?: any) {
      for (const control of form?.elements ?? []) {
        if (control instanceof Button && control !== submitter) continue;
        const name = control.name || control.getAttribute('name');
        if (name) this.#entries.push([name, String(control.value ?? '')]);
      }
    }
    get(name: string) {
      return this.#entries.find(([key]) => key === name)?.[1] ?? null;
    }
    [Symbol.iterator]() {
      return this.#entries[Symbol.iterator]();
    }
  }

  return {
    doc,
    counts,
    emitted,
    confirmations,
    setConfirmAnswer,
    fakeGlobal,
    classes: { Element, Input, Text, HTMLFormElement, Button, CustomEvent, FormData },
  };
}

interface Harness {
  applyUi(event: unknown): void;
  mount(viewId: string): any;
  doc: any;
  counts: { created: number; inserted: number; removed: number };
  emitted: any[];
  confirmations: string[];
  acceptConfirm(): void;
  declineConfirm(): void;
  finoUI: any;
  submit(form: any, submitter?: any): void;
  change(control: any): void;
  scroll(element: any): void;
}

function load(options: { fetch?: any } = {}): Harness {
  const dom = makeDom();
  const evaluate = new Function(
    'globalThis',
    'document',
    'location',
    'EventSource',
    'fetch',
    'FormData',
    'HTMLFormElement',
    'Element',
    'CustomEvent',
    'TextDecoder',
    CLIENT_SOURCE,
  );
  class NoEventSource {
    addEventListener() {}
  }
  evaluate(
    dom.fakeGlobal,
    dom.doc,
    { pathname: '/', search: '', href: '', replace() {} },
    NoEventSource,
    options.fetch ?? (() => Promise.reject(new Error('no fetch'))),
    dom.classes.FormData,
    dom.classes.HTMLFormElement,
    dom.classes.Element,
    dom.classes.CustomEvent,
    class {
      decode() {
        return '';
      }
    },
  );
  const finoUI = dom.fakeGlobal.finoUI;
  return {
    applyUi: (event: unknown) => finoUI.applyUi(event),
    mount(viewId: string) {
      const root = dom.doc.createElement('div');
      root.setAttribute('id', viewId);
      root.setAttribute('data-fi-view', 'test');
      dom.doc.appendChild(root);
      return root;
    },
    doc: dom.doc,
    counts: dom.counts,
    emitted: dom.emitted,
    confirmations: dom.confirmations,
    acceptConfirm: () => dom.setConfirmAnswer(true),
    declineConfirm: () => dom.setConfirmAnswer(false),
    finoUI,
    submit: (form: any, submitter?: any) =>
      dom.doc.dispatch('submit', { target: form, submitter, preventDefault() {} }),
    change: (control: any) => dom.doc.dispatch('change', { target: control }),
    scroll: (element: any) => dom.doc.dispatch('scroll', { target: element }),
  };
}

function render(viewId: string, tree: unknown, revision = 1) {
  return { version: 1, kind: 'render', view: 'v', viewId, revision, tree };
}

function el(type: string, props: Record<string, unknown> = {}, children: unknown[] = [], key: unknown = null) {
  return { type, props, children, key };
}

describe('bundled browser UI client', () => {
  it('reuses keyed element nodes across a reorder instead of recreating them', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(
      render('view_1', el('ul', {}, [el('li', { class: 'a' }, ['A'], 'a'), el('li', { class: 'b' }, ['B'], 'b')])),
    );
    const list = client.doc.getElementById('view_1').firstChild;
    const [firstA, firstB] = list.childNodes;

    client.applyUi(
      render('view_1', el('ul', {}, [el('li', { class: 'b' }, ['B'], 'b'), el('li', { class: 'a' }, ['A'], 'a')]), 2),
    );

    t.equal(list.childNodes[0], firstB, 'keyed child b is reused and moved first');
    t.equal(list.childNodes[1], firstA, 'keyed child a is reused and moved second');
  });

  it('performs no DOM mutation when a render is unchanged', (t) => {
    const client = load();
    client.mount('view_1');
    const tree = el('div', { class: 'card' }, [el('span', {}, ['stable'], 's')]);
    client.applyUi(render('view_1', tree));

    const before = { ...client.counts };
    client.applyUi(render('view_1', el('div', { class: 'card' }, [el('span', {}, ['stable'], 's')]), 2));

    t.equal(client.counts.created, before.created, 'no nodes are created');
    t.equal(client.counts.inserted, before.inserted, 'no nodes are inserted or moved');
    t.equal(client.counts.removed, before.removed, 'no nodes are removed');
  });

  it('keeps a focused input and its selection while the server re-renders around it', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(
      render('view_1', el('form', {}, [el('input', { name: 'q', value: '' }, [], 'q'), el('p', {}, ['0 results'], 'n')])),
    );
    const form = client.doc.getElementById('view_1').firstChild;
    const input = form.childNodes[0];
    input.value = 'typed';
    input.focus();
    input.setSelectionRange(2, 4);

    client.applyUi(
      render(
        'view_1',
        el('form', {}, [el('input', { name: 'q', value: '' }, [], 'q'), el('p', {}, ['7 results'], 'n')]),
        2,
      ),
    );

    t.equal(form.childNodes[0], input, 'the input element itself survives');
    t.equal(input.value, 'typed', 'unchanged server value does not clobber local typing');
    t.equal(client.doc.activeElement, input, 'focus is retained');
    t.deepEqual(
      { start: input.selectionStart, end: input.selectionEnd },
      { start: 2, end: 4 },
      'selection is retained',
    );
    t.equal(form.childNodes[1].childNodes[0].data, '7 results', 'sibling text still updates');
  });

  it('applies a server-changed value even to a focused input', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(render('view_1', el('input', { name: 'q', value: 'one' }, [], 'q')));
    const input = client.doc.getElementById('view_1').firstChild;
    input.focus();

    client.applyUi(render('view_1', el('input', { name: 'q', value: 'two' }, [], 'q'), 2));

    t.equal(input.value, 'two', 'an explicit server change wins over local state');
  });

  it('reuses a registered component when props are unchanged and rebuilds it when they change', (t) => {
    const client = load();
    let builds = 0;
    client.finoUI.register('app.counter.v1', (props: any) => {
      builds++;
      const node = client.doc.createElement('output');
      node.setAttribute('data-count', String(props.count));
      return node;
    });
    client.mount('view_1');
    client.applyUi(render('view_1', el('app.counter.v1', { count: 1 }, [], 'c')));
    const first = client.doc.getElementById('view_1').firstChild;
    t.equal(builds, 1);

    client.applyUi(render('view_1', el('app.counter.v1', { count: 1 }, [], 'c'), 2));
    t.equal(builds, 1, 'an unchanged component is not rebuilt');
    t.equal(client.doc.getElementById('view_1').firstChild, first, 'and its DOM node is reused');

    client.applyUi(render('view_1', el('app.counter.v1', { count: 2 }, [], 'c'), 3));
    t.equal(builds, 2, 'a changed component is rebuilt');
    t.equal(client.doc.getElementById('view_1').firstChild.getAttribute('data-count'), '2');
  });

  it('leaves a data-fi-preserve subtree untouched', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(
      render('view_1', el('div', { 'data-fi-preserve': true }, [el('span', {}, ['server'], 's')])),
    );
    const wrapper = client.doc.getElementById('view_1').firstChild;
    const local = client.doc.createElement('em');
    wrapper.appendChild(local);

    client.applyUi(
      render('view_1', el('div', { 'data-fi-preserve': true }, [el('span', {}, ['changed'], 's')]), 2),
    );

    t.equal(wrapper.childNodes.length, 2, 'locally added child survives');
    t.equal(wrapper.childNodes[1], local);
    t.equal(wrapper.childNodes[0].childNodes[0].data, 'server', 'server child is not reconciled either');
  });

  it('removes props that disappear from a later render', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(render('view_1', el('div', { class: 'on', title: 'hint' }, [], 'd')));
    const node = client.doc.getElementById('view_1').firstChild;

    client.applyUi(render('view_1', el('div', { class: 'on' }, [], 'd'), 2));

    t.equal(node.getAttribute('title'), null, 'the dropped prop is removed');
    t.equal(node.getAttribute('class'), 'on', 'the retained prop is left alone');
  });

  it('replaces a node when its component name changes at the same key', (t) => {
    const client = load();
    client.mount('view_1');
    client.applyUi(render('view_1', el('div', {}, [el('span', {}, ['x'], 'k')])));
    const wrapper = client.doc.getElementById('view_1').firstChild;
    const before = wrapper.childNodes[0];

    client.applyUi(render('view_1', el('div', {}, [el('strong', {}, ['x'], 'k')]), 2));

    t.ok(wrapper.childNodes[0] !== before, 'a different type at the same key is replaced');
    t.equal(wrapper.childNodes[0].tagName, 'strong');
  });

  it('marks a form busy for the duration of its action and reports network failure', async (t) => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = load({ fetch: () => gate.then(() => Promise.reject(new Error('offline'))) });
    client.mount('view_1');
    client.applyUi(
      render(
        'view_1',
        el('form', { action: { action: 'go', url: '/?_action=v.go', view: 'view_1', revision: 1, request: 'r' } }, [
          el('button', { type: 'submit', name: 'ok' }, ['Go'], 'b'),
        ]),
      ),
    );
    const form = client.doc.getElementById('view_1').firstChild;

    client.submit(form);
    t.equal(form.getAttribute('aria-busy'), 'true', 'the form is marked busy while in flight');
    t.equal(form.elements[0].disabled, true, 'submit controls are disabled');

    release!();
    for (let turn = 0; turn < 20 && form.getAttribute('aria-busy') !== null; turn++) {
      await Promise.resolve();
    }

    t.equal(form.getAttribute('aria-busy'), null, 'busy state clears afterwards');
    t.equal(form.elements[0].disabled, false, 'submit controls are re-enabled');
    const error = client.emitted.find((event) => event.type === 'fino-ui-error');
    t.ok(error !== undefined, 'a failure is surfaced to the page');
    t.equal(error.detail.code, 'network');
    t.equal(error.detail.recoverable, true);
    t.equal(typeof error.detail.retry, 'function', 'a retry is offered');
  });

  it('does not send an action whose confirmation is declined', (t) => {
    let sent = 0;
    const client = load({
      fetch: () => {
        sent++;
        return Promise.reject(new Error('unreachable'));
      },
    });
    client.mount('view_1');
    client.applyUi(
      render(
        'view_1',
        el(
          'form',
          {
            action: {
              action: 'remove',
              url: '/?_action=v.remove',
              view: 'view_1',
              revision: 1,
              request: 'r',
              confirm: 'Delete this?',
            },
          },
          [el('button', { type: 'submit', name: 'ok' }, ['Delete'], 'b')],
        ),
      ),
    );
    const form = client.doc.getElementById('view_1').firstChild;

    client.declineConfirm();
    client.submit(form);
    t.equal(sent, 0, 'a declined confirmation stops the request');
    t.equal(form.getAttribute('aria-busy'), null, 'and the form is never marked busy');

    client.acceptConfirm();
    client.submit(form);
    t.equal(sent, 1, 'an accepted confirmation sends it');
    t.deepEqual(
      client.confirmations,
      ['Delete this?', 'Delete this?'],
      'the server message is shown on each attempt',
    );
  });

  it('submits buttons, controlled changes, and virtual scrolls through one action path', async (t) => {
    const requests: any[] = [];
    const client = load({
      fetch: (_url: string, init: any) => {
        requests.push(JSON.parse(init.body));
        return Promise.reject(new Error('stop after capture'));
      },
    });
    client.mount('view_1');
    const action = {
      action: 'update',
      url: '/?_action=v.update',
      view: 'view_1',
      revision: 1,
      request: 'r',
    };
    client.applyUi(
      render(
        'view_1',
        el('div', {}, [
          el(
            'form',
            { action },
            [el('button', { name: 'do', value: 'save' }, ['Save'], 'button')],
            'submit',
          ),
          el(
            'form',
            { action, 'data-fi-change': '1' },
            [el('input', { name: 'value', value: 'selected' }, [], 'input')],
            'change',
          ),
          el(
            'form',
            { action },
            [
              el('input', { type: 'hidden', name: 'value', value: '0' }, [], 'offset'),
              el('div', { 'data-fi-scroll': '1', 'data-fi-row-height': '20' }, [], 'viewport'),
            ],
            'scroll',
          ),
        ]),
      ),
    );
    const wrapper = client.doc.getElementById('view_1').firstChild;
    const submitForm = wrapper.childNodes[0];
    client.submit(submitForm, submitForm.childNodes[0]);
    t.equal(requests[0].input.do, 'save', 'only the triggering button is submitted');

    const changeForm = wrapper.childNodes[1];
    client.change(changeForm.childNodes[0]);
    t.equal(requests[1].input.value, 'selected', 'a controlled change submits its value');

    const scrollForm = wrapper.childNodes[2];
    const viewport = scrollForm.childNodes[1];
    viewport.scrollTop = 100;
    client.scroll(viewport);
    await new Promise((resolve) => setTimeout(resolve, 80));
    t.equal(requests[2].input.value, '5', 'pixel offset uses the shared row-height contract');
  });

  it('surfaces heartbeat and protocol errors as page events', (t) => {
    const client = load();
    client.applyUi({ version: 1, kind: 'heartbeat' });
    client.applyUi({ version: 1, kind: 'error', code: 'stale_revision', recoverable: true });

    t.ok(client.emitted.some((event) => event.type === 'fino-ui-heartbeat'));
    const error = client.emitted.find((event) => event.type === 'fino-ui-error');
    t.equal(error.detail.code, 'stale_revision');
    t.equal(error.detail.recoverable, true);
  });

  it('ignores events from an unsupported protocol version', (t) => {
    const client = load();
    const root = client.mount('view_1');
    client.applyUi({ version: 2, kind: 'render', viewId: 'view_1', revision: 1, tree: el('div') });

    t.equal(root.childNodes.length, 0, 'a future version is not rendered');
  });

  it('fails loudly for an unregistered component name', (t) => {
    const client = load();
    client.mount('view_1');
    t.throws(
      () => client.applyUi(render('view_1', el('app.unknown.v1', {}, [], 'u'))),
      /No client component registered/,
    );
  });
});
