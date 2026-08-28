/**
 * fino:ai/acp — complete Agent Client Protocol v1 agent adapter.
 *
 * Useful references:
 *
 * - ACP v1 overview: https://agentclientprotocol.com/protocol/v1/overview
 * - Initialization: https://agentclientprotocol.com/protocol/v1/initialization
 * - Session lifecycle: https://agentclientprotocol.com/protocol/v1/session-setup
 * - Content: https://agentclientprotocol.com/protocol/v1/content
 * - Elicitation: https://agentclientprotocol.com/protocol/v1/elicitation
 * - Cancellation: https://agentclientprotocol.com/protocol/v1/cancellation
 * - Stable schema audited at ae596e1: https://github.com/agentclientprotocol/agent-client-protocol/blob/ae596e13351e1196b8b83b73f19beca51355732e/schema/v1/schema.json
 *
 * `AcpServer` implements every stable ACP v1 method, notification, content
 * variant, MCP transport, session update, and extension point. Capabilities
 * remain negotiated as ACP requires: application-policy features such as
 * authentication, modes, configuration, commands, and custom extensions are
 * advertised when their backing option is configured. Session lifecycle,
 * additional roots, rich prompts, HTTP/SSE MCP, and automatic client tools
 * are supported by default.
 *
 * Each prompt uses a fresh `AgentSession` seeded from immutable persisted
 * history. Active sessions own MCP connections and cancellation; stored
 * records survive `session/close` and connection shutdown. Persistence uses
 * the shared `fino:store` contract and the thin codecs from `fino:ai/session`,
 * so ACP and ordinary durable agent sessions share the same immutable history
 * graph and optimistic thread commits.
 *
 * ```ts no_run
 * import { acpServer, acpStdioTransport } from 'fino:ai/acp';
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 *
 * await acpServer({
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 * }).serve(acpStdioTransport());
 * ```
 */
export { AcpClient } from 'internal:ai/acp/client';
export * from 'internal:ai/acp/schema';
export { AcpServer, acpServer } from 'internal:ai/acp/server';
export type {
  AcpAgentContext,
  AcpAuthenticationOptions,
  AcpMcpServerPolicyContext,
  AcpServerOptions,
} from 'internal:ai/acp/server';
export { acpStdioTransport } from 'internal:ai/acp/transport';
