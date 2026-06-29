import {
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
} from 'fino:opentelemetry';
import { argv } from 'fino:process';
import { runDependency } from './cli-otel-dependency.ts';

async function readBodyText(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && 'text' in body && typeof body.text === 'function') {
    return await body.text();
  }
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (typeof body === 'object' && Symbol.asyncIterator in body) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array | ArrayBuffer>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(out);
  }
  return '';
}

if (argv[1] !== 'test') {
  globalThis.fetch = async function otelCliFetch(url: string | URL | Request, options: RequestInit = {}) {
    console.log(String(url));
    console.log(new Headers(options.headers).get('content-type') ?? '');
    const text = await readBodyText(options.body);
    console.log(text);
    return new Response('{}', { status: 200 });
  };
}

if (getTracerProvider() && getLoggerProvider() && getMeterProvider()) {
  console.log('entry providers ready');
}

await runDependency();
