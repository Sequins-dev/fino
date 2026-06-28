---
weight: 34
---
# Agent MCP Server

Use MCP when external clients need to discover and call your agent capabilities,
tools, or resources. Do not use MCP as an internal abstraction just to call code
inside the same process; pass tools and functions directly for that.

## Concept Map

- `mcpServer()` exposes local Fino tools and resources through MCP.
- `mountMcp()` mounts the server on a `fino:net/http/app` route.
- `MCPServer.httpHandler()` gives full control over auth, CORS, logging, and
  middleware.
- `MCPClient` connects to remote MCP servers and converts remote tools into
  Fino `Tool` instances.
- Tools still come from `fino:ai/tool` and should use `fino:validate` builders.
- Resources expose read-only context to MCP clients through `resources/list`
  and `resources/read`.

## Recommended Architecture

Wrap an agent behind one or more local tools, then expose those tools through
MCP. Keep MCP resources read-only and stable. Put authentication, authorization,
rate limiting, and logging in the application router around the mounted MCP
endpoint.

```ts
import { agent } from 'fino:ai/agent';
import { mcpServer, mountMcp } from 'fino:ai/mcp';
import { openai } from 'fino:ai/model';
import { tool } from 'fino:ai/tool';
import { App } from 'fino:net/http/app';
import { v } from 'fino:validate';

const supportAgent = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Draft concise support replies from ticket context.',
});

const draftReply = tool({
  name: 'draft_support_reply',
  description: 'Draft a customer-facing support reply from ticket notes.',
  parameters: v.object({
    ticketId: v.string().describe('Ticket id'),
    notes: v.string().describe('Relevant internal ticket notes'),
  }),
  execute: async ({ ticketId, notes }: { ticketId: string; notes: string }) => {
    const result = await supportAgent.generate(
      `Ticket ${ticketId}\n\nNotes:\n${notes}`,
    );
    return result.text;
  },
});

const server = mcpServer({
  name: 'support-agent',
  version: '1.0.0',
  instructions: 'Use these tools to draft support content and inspect support policy.',
  tools: [draftReply],
  resources: [
    {
      uri: 'support://policy/refunds',
      name: 'Refund policy',
      mimeType: 'text/markdown',
    },
  ],
  readResource: async (uri) => {
    if (uri !== 'support://policy/refunds') {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      uri,
      mimeType: 'text/markdown',
      text: '# Refund Policy\n\nRefunds require approval after 30 days.',
    };
  },
});

const app = new App();

// Add auth or other middleware in the app before mounting in real services.
mountMcp(app, '/mcp', server);
app.listen({ port: 3000 });
```

## Resources

Use MCP resources for context that clients should read but not mutate: policy
documents, generated summaries, schemas, runbooks, or project metadata. Keep
resource URIs stable and make `readResource` return compact text or blobs that
the client can cache or present to a model.

For dynamic resources, provide `resources` as a function:

```ts
const server = mcpServer({
  resources: async () => [
    { uri: 'kb://article/refunds', name: 'Refunds', mimeType: 'text/markdown' },
    { uri: 'kb://article/security', name: 'Security', mimeType: 'text/markdown' },
  ],
  readResource: async (uri, ctx) => {
    const article = await knowledgeBase.read(uri, { signal: ctx.signal });
    return { uri, mimeType: 'text/markdown', text: article.markdown };
  },
});
```

## HTTP and Stdio Choices

Use HTTP when an existing service already has routing, auth, TLS, logs, or
deployment infrastructure. Mount `server.httpHandler()` or use `mountMcp()` so
the app owns the policy around the endpoint.

Use stdio-style transports for local tools, editor integrations, tests, or
process-per-client deployments. The server can serve any JSON-RPC string
transport through `server.serve(transport)`.

Use `server.listen()` only for small local servers and tests. For composed
services, mount the handler into the application router.

## Client Integration

Remote MCP tools can be imported and passed into a Fino agent like local tools:

```ts
import { agent } from 'fino:ai/agent';
import { httpTransport, mcpClient } from 'fino:ai/mcp';
import { openai } from 'fino:ai/model';

const client = mcpClient({
  transport: httpTransport({ url: 'http://127.0.0.1:3000/mcp' }),
});

await client.connect();
const remoteTools = await client.listTools();

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  tools: remoteTools,
});
```

Close clients when the integration is done, especially when the transport owns
a child process or long-lived connection.

## Best Practices

- Expose MCP when another client needs protocol-level discovery and calls.
- Keep internal composition as direct `Tool`, `Agent`, and function calls.
- Keep MCP tools narrow, validated, and explicit about side effects.
- Use resources for read-only context, not hidden tool inputs.
- Put auth, origin policy, logging, and rate limits around the mounted endpoint.
- Prefer HTTP for service deployments and stdio for local tool processes.
