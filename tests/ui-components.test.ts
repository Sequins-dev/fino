import { describe, it } from 'fino:test/test';
import { h, type Child, type VNode } from 'fino:ui';
import {
  ComponentRegistry,
  UnsupportedComponentError,
  componentSchemaFingerprint,
  defineComponent,
  type SemanticComponentProps,
} from 'fino:ui/components';

interface ButtonProps extends SemanticComponentProps {
  label: string;
  enabled?: boolean;
}

const Button = defineComponent<ButtonProps>({
  name: 'app.button',
  version: 1,
  schema: {
    type: 'object',
    properties: {
      label: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean', default: true },
      intent: { type: 'string' },
      accessibility: { type: 'object' },
      action: { type: 'object' },
    },
    required: ['label'],
    additionalProperties: false,
  },
  slots: ['icon'],
  fallback: 'app.unsupported.v1',
});

const Unsupported = defineComponent<Record<string, unknown>>({
  name: 'app.unsupported',
  version: 1,
  schema: {
    type: 'object',
    additionalProperties: true,
  },
});

const Icon = defineComponent<{ name: string }>({
  name: 'app.icon',
  version: 1,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
    additionalProperties: false,
  },
});

function host(type: string, children: Child[] | undefined, props: Record<string, unknown>): VNode {
  return h(type, props, ...(children ?? []));
}

describe('fino:ui/components descriptors', () => {
  it('creates a JSON descriptor with stable identity, schema fingerprint, slots, and props', (t) => {
    const node = h(
      Button,
      {
        key: 'save',
        slot: 'primary',
        label: 'Save',
        intent: 'primary',
        accessibility: {
          role: 'button',
          label: 'Save changes',
        },
        action: {
          name: 'save',
          input: { source: 'toolbar' },
        },
      },
      h(Icon, { slot: 'icon', name: 'save' }),
    );

    t.equal(node.type, 'app.button.v1');
    t.equal(node.key, 'save');
    t.equal(node.slot, 'primary');
    t.deepEqual(node.component, {
      id: 'app.button.v1',
      name: 'app.button',
      version: 1,
      schemaFingerprint: componentSchemaFingerprint(Button.schema),
      slots: ['icon'],
      fallback: 'app.unsupported.v1',
    });
    t.deepEqual(node.props, {
      label: 'Save',
      enabled: true,
      intent: 'primary',
      accessibility: {
        role: 'button',
        label: 'Save changes',
      },
      action: {
        name: 'save',
        input: { source: 'toolbar' },
      },
    });
    t.equal((node.children[0] as VNode).slot, 'icon');
    t.deepEqual(JSON.parse(JSON.stringify(node)), node, 'the semantic VNode is wire-safe JSON');
  });

  it('rejects invalid definitions and non-JSON or schema-invalid props', (t) => {
    t.throws(
      () =>
        defineComponent({
          name: 'button',
          version: 1,
          schema: { type: 'object' },
        }),
      /namespaced/,
    );
    t.throws(
      () =>
        defineComponent({
          name: 'app.invalid',
          version: 0,
          schema: { type: 'object' },
        }),
      /positive integer/,
    );
    t.throws(
      () =>
        defineComponent({
          name: 'app.button.v1',
          version: 1,
          schema: { type: 'object' },
        }),
      /version suffix/,
    );
    t.throws(() => h(Button, { label: '' }), /label/);
    t.throws(() => h(Button, { label: 'Save', handler: () => {} }), /handler/);
    t.throws(() => h(Unsupported, { handler: () => {} }), /JSON-compatible/);
    t.throws(
      () => h(Button, { label: 'Save' }, h(Icon, { slot: 'trailing', name: 'save' })),
      /does not declare child slot/,
    );
  });

  it('fingerprints equivalent schema objects independently of key order', (t) => {
    t.equal(
      componentSchemaFingerprint({
        type: 'object',
        properties: {
          second: { type: 'number' },
          first: { type: 'string' },
        },
      }),
      componentSchemaFingerprint({
        properties: {
          first: { type: 'string' },
          second: { type: 'number' },
        },
        type: 'object',
      }),
    );
  });
});

describe('fino:ui/components registry', () => {
  it('maps one semantic tree to target-native implementations and advertises data-only capabilities', (t) => {
    const tree = h(
      'screen',
      null,
      h(Button, {
        key: 'save',
        label: 'Save',
        accessibility: { role: 'button' },
        action: { name: 'save' },
      }),
    );
    const registries = {
      html: new ComponentRegistry('html').register(Button, (input) =>
        host('button', input.children, {
          type: 'submit',
          'aria-role': input.props.accessibility?.role,
          'data-action': input.props.action?.name,
        }),
      ),
      tui: new ComponentRegistry('tui').register(Button, (input) =>
        host('button', input.children, {
          label: input.props.label,
          role: input.props.accessibility?.role,
          action: input.props.action?.name,
        }),
      ),
      'mock-swiftui': new ComponentRegistry('mock-swiftui').register(Button, (input) =>
        host('MockNativeButton', input.children, {
          title: input.props.label,
          action: input.props.action?.name,
        }),
      ),
      'mock-compose': new ComponentRegistry('mock-compose').register(Button, (input) =>
        host('MockNativeButton', input.children, {
          text: input.props.label,
          onClick: input.props.action?.name,
        }),
      ),
    };
    const resolved = Object.fromEntries(
      Object.entries(registries).map(([target, registry]) => [target, registry.resolve(tree)]),
    ) as Record<string, VNode>;

    t.equal((resolved.html.children[0] as VNode).type, 'button');
    t.equal((resolved.tui.children[0] as VNode).type, 'button');
    t.equal((resolved['mock-swiftui'].children[0] as VNode).type, 'MockNativeButton');
    t.equal((resolved['mock-compose'].children[0] as VNode).type, 'MockNativeButton');
    t.deepEqual((resolved.html.children[0] as VNode).props, {
      type: 'submit',
      'aria-role': 'button',
      'data-action': 'save',
    });
    t.deepEqual((resolved.tui.children[0] as VNode).props, {
      label: 'Save',
      role: 'button',
      action: 'save',
    });
    t.deepEqual((resolved['mock-swiftui'].children[0] as VNode).props, {
      title: 'Save',
      action: 'save',
    });
    t.deepEqual((resolved['mock-compose'].children[0] as VNode).props, {
      text: 'Save',
      onClick: 'save',
    });
    for (const target of Object.values(resolved))
      t.equal((target.children[0] as VNode).key, 'save', 'stable identity crosses targets');
    t.deepEqual(registries.html.capabilities(), {
      target: 'html',
      components: [Button.reference],
    });
    t.deepEqual(
      JSON.parse(JSON.stringify(registries.html.capabilities())),
      registries.html.capabilities(),
      'capabilities never contain renderer functions',
    );
    t.throws(() => registries.html.register(Button, () => h('button', null)), /already registered/);
  });

  it('uses declared fallbacks and rejects unsupported schema versions without one', (t) => {
    const fallbackRegistry = new ComponentRegistry('minimal').register(Unsupported, (input) =>
      host('unsupported', input.children, {
        requested: input.component.id,
      }),
    );
    const resolved = fallbackRegistry.resolve(h(Button, { label: 'Save' }));
    t.equal(resolved.type, 'unsupported');
    t.deepEqual(resolved.props, { requested: 'app.button.v1' });

    const incompatible = {
      ...h(Button, { label: 'Save' }),
      component: {
        ...Button.reference,
        schemaFingerprint: 'fnv1a32:incompatible',
        fallback: undefined,
      },
    };
    const exactRegistry = new ComponentRegistry('exact').register(Button, (input) =>
      host('button', input.children, input.props),
    );
    t.throws(
      () => exactRegistry.resolve(incompatible),
      (error) =>
        error instanceof UnsupportedComponentError &&
        error.component.id === 'app.button.v1' &&
        /schema/.test(error.message),
    );
  });

  it('rejects recursive renderer output', (t) => {
    const registry = new ComponentRegistry('cycle').register(Button, (input) =>
      h(Button, input.props, ...input.children),
    );
    t.throws(() => registry.resolve(h(Button, { label: 'Save' })), /cycle/);
  });

  it('allows finite nesting of the same semantic component', (t) => {
    const registry = new ComponentRegistry('nested').register(Button, (input) =>
      host('button', input.children, { label: input.props.label }),
    );
    const resolved = registry.resolve(h(Button, { label: 'Outer' }, h(Button, { label: 'Inner' })));
    t.equal(resolved.type, 'button');
    t.equal((resolved.children[0] as VNode).type, 'button');
    t.deepEqual((resolved.children[0] as VNode).props, { label: 'Inner' });
  });
});
