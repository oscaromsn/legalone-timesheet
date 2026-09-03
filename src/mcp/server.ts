/*
 * Assembles the Legal One tools into an MCP server.
 *
 * Thin on purpose: this file registers, it does not decide. Every rule about how
 * Legal One behaves lives in the library, so that the three offline gates keep
 * covering it and a second front end would inherit the same guarantees.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readTools, type Tool } from './tools-read.ts';
import { writeTools } from './tools-write.ts';

export const allTools: Tool[] = [...readTools, ...writeTools];

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'legalone-timesheet', version: '0.1.0' },
    {
      instructions:
        'Drives Legal One (NovaJus) for timesheet and matter work.\n\n' +
        'Call authenticate first. If any tool reports sign-in required, a browser window is already open — ' +
        'ask the person to sign in and wait for them to say so; never retry on your own.\n\n' +
        'Reads are free. For anything about totals or trends use export_timesheet, which returns a summary and a ' +
        'file rather than filling the conversation.\n\n' +
        'Before booking hours, run plan_entries and show the result. The states it declines to decide — ambiguous, ' +
        'matter-missing, escalate — are ones where a wrong guess bills the wrong client and nothing surfaces it.\n\n' +
        'Registering a matter is the one irreversible action: matters cannot be deleted. propose_matter issues a ' +
        'token for exactly the answers a person approved, and create_matter refuses any other.\n\n' +
        'Timesheet data is scoped to the signed-in user; this tenant does not return other people\'s entries.',
    },
  );

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        const result = await tool.run(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false,
        };
      },
    );
  }
  return server;
}
