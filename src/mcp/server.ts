/*
 * Assembles the Legal One tools into an MCP server.
 *
 * Thin on purpose: this file registers, it does not decide. Every rule about how
 * Legal One behaves lives in the library, so that the three offline gates keep
 * covering it and a second front end would inherit the same guarantees.
 */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { classifyState } from '../config.ts';
import { readTools, type Tool } from './tools-read.ts';
import { writeTools } from './tools-write.ts';
import { configTools } from './tools-config.ts';
import { registerPrompts } from './prompts.ts';

/*
 * Said at the handshake, because the alternative is saying it in an error.
 *
 * A real session lost a week of timesheet to this: the agent read 62 lines, told the
 * person it would classify them, and only then discovered — from a failed write —
 * that the installation had never been configured. Nothing before that point could
 * have told it. The tool list, the descriptions and these instructions were
 * byte-identical to a configured install's.
 *
 * Note what this does NOT say: it never asks the model to go and check for a file.
 * An agent told to look for missing configuration finds it missing and writes one,
 * with ids it guessed. The server knows the state, so the server declares it.
 */
const UNCONFIGURED =
  'THIS INSTALLATION IS NOT CONFIGURED. The firm\'s ids have never been read, so no configuration file ' +
  'exists. Reading, searching and plan_entries all work: run the plan and show it. A line it could not ' +
  'place comes back `unconfigured`, which means the name was searched exactly as the timesheet wrote it ' +
  'with no alias table — it does NOT mean the client is unregistered, and must never be reported that ' +
  'way. That plan is the evidence the alias decisions need, because it says how many hours ride on each ' +
  'unresolved name. Booking is unavailable until propose_config and apply_config have run, and ' +
  'log_entries is withheld from the tool list until then.\n\n';

/**
 * Routing lives here rather than in a prompt, because prompts are invoked by the
 * person and this journey starts with a sentence — "I want to log my hours, my day
 * went like this" — that touches no prompt at all. These are the rules that must hold
 * when nothing was invoked and the model is one turn away from writing to a system
 * where a rejected save returns HTTP 200.
 *
 * Takes the state rather than reading it, so a gate can hold both variants against
 * the tool names they use without arranging a filesystem to do it.
 */
export const instructionsFor = (configured: boolean): string =>
  'Drives Legal One (NovaJus) for a lawyer: timesheet entries, matters, and the analysis of both.\n\n' +
    (configured ? '' : UNCONFIGURED) +
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

/** The instructions as a configured installation sees them. */
export const INSTRUCTIONS = instructionsFor(true);

/** What the handshake actually carries, which depends on what is on disk. */
export const instructions = (): string => instructionsFor(classifyState().aliasTable);

export const allTools: Tool[] = [...readTools, ...writeTools, ...configTools];

/*
 * Withheld while there is no configuration, because a tool an agent cannot see is a
 * plan it cannot make. Deliberately just this one: update_entry, delete_entry and
 * set_entry_status address an existing entry by id and never bind the template, and
 * plan_entries is the thing that should still work.
 */
export const GATED_ON_CONFIG = new Set(['log_entries']);

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'legalone-timesheet', version: '0.1.0' },
    {
      instructions: instructions(),
    },
  );

  const gated = new Map<string, RegisteredTool>();

  /*
   * Re-run after every call rather than wired to a config event: apply_config is not
   * the only way the answer changes — setup --write and a person editing the file both
   * move it — and `classifyState` reads a memo, so asking is cheaper than subscribing.
   * Toggling emits notifications/tools/list_changed on its own.
   */
  const syncAvailability = () => {
    const available = classifyState().aliasTable;
    for (const registered of gated.values()) {
      if (available !== registered.enabled) available ? registered.enable() : registered.disable();
    }
  };

  for (const tool of allTools) {
    const registered = server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        const result = await tool.run(args);
        syncAvailability();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false,
        };
      },
    );
    if (GATED_ON_CONFIG.has(tool.name)) gated.set(tool.name, registered);
  }
  syncAvailability();
  registerPrompts(server);
  return server;
}
