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
import { configTools } from './tools-config.ts';
import { registerPrompts } from './prompts.ts';

/*
 * Routing lives here rather than in a prompt, because prompts are invoked by the
 * person and this journey starts with a sentence — "I want to log my hours, my day
 * went like this" — that touches no prompt at all. These are the rules that must hold
 * when nothing was invoked and the model is one turn away from writing to a system
 * where a rejected save returns HTTP 200.
 *
 * Exported so a gate can hold it against the tool names it uses.
 */
export const INSTRUCTIONS =
  'Drives Legal One (NovaJus) for a lawyer: timesheet entries, matters, and the analysis of both.\n\n' +
    'TWO GATES, IN THIS ORDER, BEFORE ANY WORK.\n\n' +
    '1. A session. session_status is free and establishes nothing. If there is none, tell the person, BEFORE ' +
    'calling authenticate, that a browser window will open for them to sign in to Legal One as they normally ' +
    'do, and that the session is kept only on this computer — no password is seen or stored by anyone here. ' +
    'Then call authenticate. If any tool answers sign-in required, a window is already open: say so and wait ' +
    'for the person. Never call authenticate again hoping the state changed; only they can change it.\n\n' +
    '2. A configuration. Anything answering that this installation is not configured means the firm\'s ids ' +
    'have never been read. Do not guess one and do not invent an alias: call propose_config, show the ' +
    'evidence, settle what the records do not with the person, then apply_config. Alias candidates are ' +
    'approved ONE AT A TIME — each rewrites every future line beginning with that name — and a candidate the ' +
    'proposal refused stays refused.\n\n' +
    'BOOKING HOURS. Always plan_entries first and show the result. linked and internal are decided; ' +
    'ambiguous, matter-missing and escalate are ANSWERS, not errors — they are the cases where a guess bills ' +
    'the wrong client and nothing ever surfaces it. Take them to the person, then pass their decisions to ' +
    'log_entries with the configVersion plan_entries returned.\n\n' +
    'IRREVERSIBILITY. Matters cannot be deleted. propose_matter issues a token for exactly the answers a ' +
    'person approved and create_matter refuses any other. Entries can be deleted, so fixing one is cheap.\n\n' +
    'ANALYSIS. Use export_timesheet for anything about totals, distribution or trends: it returns a summary ' +
    'and a spreadsheet path rather than filling the conversation. Every export leaves a row in the firm\'s ' +
    'own generated-reports list, which colleagues can see, so do not run variations casually.\n\n' +
    'SCOPE. Timesheet data is the signed-in user\'s own. This tenant does not return other people\'s ' +
    'entries whatever filter is applied, so firm-wide questions need a different permission, not another ' +
    'attempt.';

export const allTools: Tool[] = [...readTools, ...writeTools, ...configTools];

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'legalone-timesheet', version: '0.1.0' },
    {
      instructions: INSTRUCTIONS,
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
  registerPrompts(server);
  return server;
}
