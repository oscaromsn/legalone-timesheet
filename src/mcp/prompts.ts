/*
 * The procedures a person starts on purpose.
 *
 * These surface in the client as something the lawyer picks — so their names and
 * descriptions are in Portuguese, and their bodies are in English because their
 * reader is the model. They are an accelerator, not the routing: a prompt is invoked
 * by a person, and the journey this connector is built for starts with a sentence,
 * not a menu. What must hold when nothing was invoked lives in the server's
 * `instructions`; what is here is the long version, for when someone asked for it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface Prompt {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodRawShape;
  body: (args: Record<string, string | undefined>) => string;
}

export const prompts: Prompt[] = [
  {
    name: 'lancar-horas',
    title: 'Lançar horas no Legal One',
    description:
      'Transforma as anotações do seu dia em lançamentos de timesheet. Classifica cada linha contra o Legal One, ' +
      'mostra o que encontrou e só lança depois que você confirmar — nada é escrito sem passar por você.',
    argsSchema: { notas: z.string().optional() },
    body: ({ notas }) => [
      'Book timesheet entries in Legal One from the notes below.',
      '',
      'Work in this order and do not skip a step:',
      '',
      '1. session_status. If no session is held, tell the person a browser window will open for them to sign in to',
      '   Legal One as they normally do, and that the session stays on this computer only. Then authenticate.',
      '   If anything answers sign-in required, a window is already open — say so and wait for them.',
      '2. Turn the notes into lines of date, startTime, endTime and description. Ask about anything you cannot',
      '   read out of them; do not invent a time or a duration.',
      '3. plan_entries with those lines. Show the person every line and its state, in their language.',
      '4. For each ambiguous, matter-missing or escalate line, take the question to the person. These are the',
      '   states where a guess books hours against the wrong client and nothing surfaces it afterwards. Use',
      '   search_matters and resolve_matter_by_cnj to give them real options rather than asking in the abstract.',
      '5. log_entries with their decisions and the configVersion plan_entries returned. Report the ids that were',
      '   written, what was already logged, and — separately and in hours — what was held and why. Held time is',
      '   time that will go unbilled unless somebody sees it.',
      '',
      'If anything reports that the installation is not configured, stop and offer the "Configurar o Legal One"',
      'procedure instead. Never guess an id to get past it.',
      '',
      notas ? `The notes:\n\n${notas}` : 'Ask the person for the notes first.',
    ].join('\n'),
  },
  {
    name: 'configurar',
    title: 'Configurar o Legal One',
    description:
      'Primeira configuração: entra na sua conta, lê os lançamentos que o escritório já fez e propõe os valores ' +
      'que todo lançamento carrega. Mostra a evidência de cada um e pergunta o que os registros não resolvem.',
    argsSchema: {},
    body: () => [
      'Configure this installation from the firm\'s own records. Nothing is written without approval.',
      '',
      '1. Before authenticate, explain plainly: a browser window will open, they sign in to Legal One the way they',
      '   always do — second factor included — and the resulting session is kept only on this computer, in a',
      '   profile this connector owns. No password is seen or stored here. Then authenticate, and wait for them if',
      '   it answers sign-in required.',
      '2. doctor, with a small days window to start. If a check FAILS, stop: an assumption this client is built on',
      '   does not hold on their Legal One, and configuring anyway produces a setup that looks right and files',
      '   hours wrong. Warnings are for reading, not for fixing.',
      '3. propose_config with no arguments. Read what came back and present it in their language:',
      '   - each proposed id, what it means, and how many of their own records agreed;',
      '   - anything in `unresolved` or contested — the records did not settle it, so they must;',
      '   - the alias candidates, ONE AT A TIME. For each, show the name their timesheet uses, the name Legal One',
      '     files it under, the lines it was read from, and what a search for each returns today. Say plainly what',
      '     it will do: every future line beginning with that name will be booked to that client. Never present',
      '     them as a block for one approval, and never revive one the proposal refused — the refusals are there',
      '     because a head that names work rather than a party silently redirects every line that starts with it.',
      '4. For anything unresolved, use lookup to show the tenant\'s real options and let them choose. Do not guess.',
      '   If they have no timesheet history at all, everything is unresolved: work through the lookups with them.',
      '4b. If they say a client\'s lines all belong to one specific matter — "tudo do X vai para a pasta Y" — that',
      '    is `matters`, keyed by the head their line starts with, valued by the CNJ, folder number or record id',
      '    they gave you. It is not `overrides`, which settles only the six firm defaults and now refuses any',
      '    other key. Read the `matters` block of the answer back to them: it says which matter each head landed',
      '    on and how the value was read, and it is the only way either of you can tell it was understood.',
      '5. propose_config again, carrying their approved aliases and choices, to get a confirmationToken.',
      '6. apply_config with those exact arguments and the token.',
      '',
      'Finish by telling them the configuration is in force but marked provisional — written here and never',
      'checked against Legal One. Nothing else is needed from them now: the next time they book hours,',
      'log_entries files the first line for real, reads it back field by field and stops, so they can look at that',
      'one entry in Legal One before the rest follow. If it comes back wrong the line is deleted and nothing is',
      'booked. Reading, searching and planning all work meanwhile.',
    ].join('\n'),
  },
  {
    name: 'analisar-horas',
    title: 'Analisar minhas horas',
    description:
      'Puxa seu timesheet como planilha e responde perguntas sobre ele — para onde foram as horas, quanto por ' +
      'cliente, o que ainda está pendente.',
    argsSchema: { periodo: z.string().optional(), pergunta: z.string().optional() },
    body: ({ periodo, pergunta }) => [
      'Analyse this person\'s timesheet.',
      '',
      '1. Ensure a session, as always: session_status, then authenticate if needed, explaining the window first.',
      '2. export_timesheet for the period. It returns a summary and a file path, never the rows — read the file',
      '   when the question needs per-entry detail. It takes about twenty seconds, and each export leaves a row in',
      '   the firm\'s generated-reports list that colleagues can see, so do not run variations casually.',
      '3. Answer the question from the data. Durations in the file are day fractions: 0.125 is three hours.',
      '',
      'Two limits to state rather than work around. The figures are this person\'s own entries — the tenant does',
      'not return other people\'s whatever filter is applied — so a question about the team needs a different',
      'permission, not another attempt. And the server ignores date filters, so the range is applied after',
      'download: `exportedBeforeFilter` says how many entries existed before it.',
      '',
      periodo ? `Period: ${periodo}` : 'Ask which period if they did not say.',
      pergunta ? `The question: ${pergunta}` : '',
    ].filter(Boolean).join('\n'),
  },
];

export function registerPrompts(server: McpServer): void {
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      // The SDK hands the handler `unknown` values; every argument here is optional
      // text, so anything that is not a string is the same as absent.
      (args: Record<string, unknown>) => {
        const text = Object.fromEntries(
          Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]),
        );
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.body(text) } }] };
      },
    );
  }
}
