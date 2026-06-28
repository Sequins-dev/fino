import { describe, it } from 'fino:test/test';
import { local, localProvider, hasLlamaCpp, LocalModelLibraryError, LocalModelUnsupportedError } from 'fino:ai/model/local';
import { local as topLevelLocal, hasLlamaCpp as topLevelHasLlamaCpp } from 'fino:ai/model';
import { DiskFileSystem } from 'fino:file';
import { join } from 'fino:file/path';

type FakeBinding = {
  opened: Array<{ path: string; options: Record<string, number> }>;
  generated: string[];
  closed: number[];
  output: string;
  open(path: string, options: Record<string, number>): Promise<number>;
  generate(handle: number, prompt: string, options: Record<string, unknown>): Promise<string>;
  close(handle: number): void;
};

function fakeBinding(output = 'local output'): FakeBinding {
  return {
    opened: [],
    generated: [],
    closed: [],
    output,
    async open(path, options) {
      this.opened.push({ path, options });
      return this.opened.length;
    },
    async generate(_handle, prompt) {
      this.generated.push(prompt);
      return this.output;
    },
    close(handle) {
      this.closed.push(handle);
    },
  };
}

function textResponse(text: string, status = 200) {
  return {
    status,
    body: null,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve({}),
  };
}

describe('local llama.cpp model adapter', () => {
  it('exports a module-time llama.cpp availability boolean', (t) => {
    t.equal(typeof hasLlamaCpp, 'boolean');
    t.equal(typeof topLevelHasLlamaCpp, 'boolean');
    t.equal(typeof topLevelLocal, 'function');
    t.equal(typeof local, 'function');
  });

  it('generates text with real libllama and a tiny GGUF model', async (t) => {
    t.equal(hasLlamaCpp, true, 'default libllama discovery must be available for real local model tests');

    const model = await local({
      model: {
        repo: 'bartowski/SmolLM2-135M-Instruct-GGUF',
        file: 'SmolLM2-135M-Instruct-Q2_K.gguf',
        revision: 'main',
      },
      cacheDir: join('/tmp', 'fino-local-model-real').toString(),
      contextSize: 128,
      batchSize: 32,
      threads: 2,
      gpuLayers: 0,
      maxTokens: 8,
      temperature: 0,
      stopSequences: ['\n'],
    });

    try {
      const result = await model.generate({
        messages: [{ role: 'user', content: 'Complete this sentence: Once upon a' }],
      });
      t.equal(typeof result.text, 'string');
      t.ok(result.text.trim().length > 0, `expected non-empty generated text, got ${JSON.stringify(result.text)}`);
    } finally {
      (model as { close?: () => void }).close?.();
    }
  });

  it('loads a local GGUF path through injected bindings', async (t) => {
    const binding = fakeBinding('hello from llama');
    const model = await local({
      model: '/tmp/model.gguf',
      bindings: binding,
      contextSize: 2048,
      threads: 2,
      batchSize: 128,
      gpuLayers: 1,
      maxTokens: 12,
      temperature: 0.3,
    });

    t.equal(model.id, '/tmp/model.gguf');
    t.equal(model.provider, 'local');
    t.equal(binding.opened[0].path, '/tmp/model.gguf');
    t.equal(binding.opened[0].options.contextSize, 2048);
    t.equal(binding.opened[0].options.threads, 2);

    const result = await model.generate({
      messages: [{ role: 'user', content: 'Say hi.' }],
    });
    t.equal(result.text, 'hello from llama');
    t.equal(result.stopReason, 'end_turn');
    t.equal(binding.generated.length, 1);
    t.ok(binding.generated[0].includes('User: Say hi.'));
  });

  it('streams generated output through the ModelStream interface', async (t) => {
    const model = await local({ model: '/tmp/model.gguf', bindings: fakeBinding('streamed') });
    const events = [];
    for await (const event of model.stream({ messages: [{ role: 'user', content: 'go' }] })) {
      events.push(event);
    }

    t.equal(events[0].type, 'text_delta');
    t.equal((events[0] as { text: string }).text, 'streamed');
    t.equal(events.at(-1)?.type, 'stop');
  });

  it('downloads and caches explicit Hugging Face GGUF files', async (t) => {
    const fs = new DiskFileSystem();
    const cacheDir = join('/tmp', `fino-local-model-${Date.now()}`).toString();
    await fs.mkdir(cacheDir);

    const binding = fakeBinding('cached');
    const client = {
      requests: [] as string[],
      async request(url: string) {
        this.requests.push(url);
        return textResponse('gguf bytes');
      },
    };

    const model = await local({
      model: { repo: 'owner/repo', file: 'tiny.Q4_K_M.gguf', revision: 'main' },
      cacheDir,
      client,
      bindings: binding,
    });
    await model.generate({ messages: [{ role: 'user', content: 'cached?' }] });

    const expectedPath = join(cacheDir, 'owner__repo', 'main', 'tiny.Q4_K_M.gguf').toString();
    t.equal(client.requests[0], 'https://huggingface.co/owner/repo/resolve/main/tiny.Q4_K_M.gguf');
    t.equal(binding.opened[0].path, expectedPath);

    const second = await local({
      model: { repo: 'owner/repo', file: 'tiny.Q4_K_M.gguf', revision: 'main' },
      cacheDir,
      client,
      bindings: fakeBinding('cached again'),
    });
    await second.generate({ messages: [{ role: 'user', content: 'cached again?' }] });
    t.equal(client.requests.length, 1, 'cached file avoids a second download');
  });

  it('rejects unsupported local model options clearly', async (t) => {
    await t.rejects(
      () => local({ model: { repo: 'owner/repo', file: 'model.bin' }, bindings: fakeBinding() }),
      /GGUF/i,
    );

    const model = await local({ model: '/tmp/model.gguf', bindings: fakeBinding() });
    await t.rejects(
      () => model.generate({ messages: [{ role: 'user', content: 'json' }], responseFormat: { type: 'json_schema', schema: {} } }),
      LocalModelUnsupportedError,
    );
    await t.rejects(
      () => model.embed(['x']),
      LocalModelUnsupportedError,
    );
  });

  it('throws LocalModelLibraryError when no llama.cpp binding is available', async (t) => {
    try {
      await local({ model: '/tmp/model.gguf', libraryPath: '/definitely/not/libllama.dylib' });
      t.ok(false, 'expected local() to reject for an invalid libllama path');
    } catch (err) {
      t.ok(err instanceof LocalModelLibraryError);
      const message = String((err as Error).message);
      t.ok(message.includes('libllama'), 'error points callers at system libllama');
      t.ok(!message.includes('libfino_llama'), 'error must not mention the removed shim');
    }
  });

  it('localProvider lists configured models and ModelInfo.create constructs them', async (t) => {
    const binding = fakeBinding('registry');
    const provider = localProvider({
      models: [{ id: 'tiny-local', model: '/tmp/tiny.gguf', displayName: 'Tiny Local' }],
      bindings: binding,
    });

    const infos = await provider.listModels();
    t.equal(infos[0].id, 'tiny-local');
    t.equal(infos[0].provider, 'local');
    t.equal(infos[0].displayName, 'Tiny Local');

    const model = await infos[0].create({ maxTokens: 5 });
    t.equal(model.id, 'tiny-local');
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    t.equal(binding.opened[0].path, '/tmp/tiny.gguf');
  });
});
