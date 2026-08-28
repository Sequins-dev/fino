import { acpStdioTransport } from 'fino:ai/acp';
import { mcpServer } from 'fino:ai/mcp';
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';

await mcpServer({
  name: 'acp-test-tools',
  tools: [
    tool({
      name: 'echo',
      description: 'Echo a value for ACP integration tests.',
      parameters: v.object({ value: v.string() }),
      execute: ({ value }: { value: string }) => `echo:${value}`,
    }),
  ],
}).serve(acpStdioTransport());
