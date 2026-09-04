/*
 * Session, reading and export. Nothing here changes anything in Legal One.
 *
 * All of it goes through `read()` from auth.ts: a read that meets an expired
 * session renews and runs again, because repeating a question costs a request and
 * answers nothing wrongly.
 */
import { z } from 'zod';
import { read } from '../auth.ts';
import { classifyState, configProvisional, configState } from '../config.ts';
import { exportTimesheet, hoursOf } from '../export.ts';
import { context, sessionHandle, guard, page, type ToolResult } from './context.ts';

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run: (args: any) => Promise<ToolResult>;
}

const dateArg = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'dd/MM/yyyy');

/**
 * How many grid pages to fetch to satisfy a page of results.
 *
 * Paging the *results* is not enough: an unbounded search walks every page before
 * slicing, and a broad term on a real firm means hundreds of records and a request
 * that outlives the client's timeout. Grids hold 18 rows, so this fetches what the
 * caller asked for and one page of slack.
 */
const pagesFor = (limit: number, offset: number): number => Math.ceil((limit + offset) / 18) + 1;

/*
 * The second gate, answered by the tool that clears the first.
 *
 * Signing in is the moment an agent starts planning what it will do, and until this
 * existed the only way to learn the installation was unconfigured was to attempt a
 * write and be refused — one turn after promising a person their week would be filed.
 * It is stated, not delegated: nothing here tells the model to go looking for a file.
 */
const configuration = () => {
  const write = configState();
  const classify = classifyState();
  return {
    configured: write.configured,
    provisional: write.configured && configProvisional(),
    canPlan: true,
    canBook: write.configured && !configProvisional(),
    reasons: write.reasons,
    nextStep:
      !classify.aliasTable
        ? 'call propose_config — this installation has never been set up. plan_entries works meanwhile, and ' +
          'labels what it could not decide `unconfigured` rather than unregistered.'
      : !write.configured
        ? 'call propose_config to fill what is still unset; plan_entries works meanwhile'
      : configProvisional()
        ? 'the configuration has never been proved against Legal One: the next log_entries files one real ' +
          'line, reads it back, and stops for a person to check it'
        : null,
  };
};

export const readTools: Tool[] = [
  {
    name: 'authenticate',
    description:
      'Establishes the Legal One session. Returns ready when it renewed silently (a few seconds, no window), ' +
      'or sign-in required with the URL of a browser window that is already open. Call it first, or when another ' +
      'tool reports sign-in required. Never call it repeatedly hoping the state changes — a person has to act. ' +
      'Also reports whether this installation is configured, so the answer arrives before any work is planned ' +
      'rather than out of a refused write.',
    schema: {},
    run: () => guard(async () => {
      const session = sessionHandle();
      await session.cookie();
      return { ok: true, state: 'ready', tenant: session.tenant(), configuration: configuration() };
    }),
  },
  {
    name: 'session_status',
    description:
      'Reports whether a session is held and for which tenant, and whether this installation is configured, ' +
      'without establishing anything. Cheap; use it to explain state rather than to obtain access.',
    schema: {},
    run: async () => {
      const session = sessionHandle();
      return {
        ok: true,
        tenant: session.tenant(),
        established: session.tenant() !== null,
        configuration: configuration(),
      };
    },
  },
  {
    name: 'list_entries',
    description:
      'Timesheet entries in a date range, newest page first. Scoped to the signed-in user — this tenant does not ' +
      'return other people\'s entries, whatever filter is applied. For analysis over a long period prefer ' +
      'export_timesheet, which returns a spreadsheet instead of filling the conversation.',
    schema: { from: dateArg, to: dateArg, limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) },
    run: ({ from, to, limit, offset }) => guard(async () => {
      const { client, renew } = await context();
      const all = await read(() => client.listEntries(from, to), renew);
      const { items, total, more } = page(all, limit, offset);
      return { ok: true, total, more, entries: items.map((e) => ({ id: e.id, inicio: e.inicio, termino: e.termino, situacao: e.situacao, descricao: e.descricao })) };
    }),
  },
  {
    name: 'search_matters',
    description:
      'Searches matters by CNJ, folder label, title or party name. A name search is a discovery aid, not a lookup: ' +
      'on a criminal matter the registered client is the individual defendant, so a company name may never return ' +
      'its own case. When you have a CNJ, use resolve_matter_by_cnj instead — it is exact. Only enough pages are ' +
      'fetched to answer, so `total` is what was seen, not what exists — narrow the term rather than paging far.',
    schema: { term: z.string().min(1), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) },
    run: ({ term, limit, offset }) => guard(async () => {
      const { client, renew } = await context();
      const all = await read(() => client.searchProcessos(term, pagesFor(limit, offset)), renew);
      const { items, total, more } = page(all, limit, offset);
      return { ok: true, total, more, matters: items.map((p) => ({ id: p.id, cnj: p.cnj, pasta: p.pasta, cliente: p.cliente, titulo: p.titulo, responsavel: p.responsavel })) };
    }),
  },
  {
    name: 'search_contacts',
    description: 'Searches registered contacts — clients, opposing parties, courts. Answers "is this client registered at all?", which is the question that decides between registering a matter and escalating to a person.',
    schema: { term: z.string().min(1), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0) },
    run: ({ term, limit, offset }) => guard(async () => {
      const { client, renew } = await context();
      const all = await read(() => client.searchContatos(term, pagesFor(limit, offset)), renew);
      const { items, total, more } = page(all, limit, offset);
      return { ok: true, total, more, contacts: items.map((c) => ({ id: c.id, nome: c.nome, documento: c.documento })) };
    }),
  },
  {
    name: 'resolve_matter_by_cnj',
    description: 'Finds the one matter carrying a CNJ. Fails rather than choosing when zero or several match, which is the right outcome: booking hours against the wrong matter is invisible afterwards.',
    schema: { cnj: z.string().min(1) },
    run: ({ cnj }) => guard(async () => {
      const { client, renew } = await context();
      const p = await read(() => client.resolveProcesso(cnj), renew);
      return { ok: true, matter: { id: p.id, cnj: p.cnj, pasta: p.pasta, cliente: p.cliente, titulo: p.titulo } };
    }),
  },
  {
    name: 'read_matter',
    description:
      'Reads a matter as fields. The form carries around 400, so only fields with a value come back; pass `fields` ' +
      'when you know what you want. For inspection only — it keeps the first value per name, which is what the ' +
      'server binds, and cannot be posted back.',
    schema: { id: z.number().int().positive(), fields: z.array(z.string()).optional() },
    run: ({ id, fields }) => guard(async () => {
      const { client, renew } = await context();
      const all = await read(() => client.readMatter(id), renew);
      const wanted = fields
        ? Object.fromEntries(fields.map((f: string) => [f, all[f] ?? '']))
        : Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ''));
      return { ok: true, id, fieldCount: Object.keys(wanted).length, fields: wanted };
    }),
  },
  {
    name: 'lookup',
    description:
      'Queries one of Legal One\'s pickers by its contentUrl, e.g. /contatos/Contatos/LookupGridContato. Several ' +
      'return near-identical labels — three different ids can all render "1º Grau" — so present the options and let ' +
      'a person choose. Never take the first row as the answer.',
    schema: { path: z.string().min(1), term: z.string().optional(), extra: z.record(z.string(), z.string()).optional() },
    run: ({ path, term, extra }) => guard(async () => {
      const { client, renew } = await context();
      const rows = await read(() => client.lookup(path, term, extra ?? {}), renew);
      return { ok: true, count: rows.length, rows: rows.slice(0, 50) };
    }),
  },
  {
    name: 'export_timesheet',
    description:
      'Exports every timesheet entry as a real .xlsx and returns a summary plus the file path — never the rows ' +
      'themselves. Use it for any question about totals, distribution or trends. Takes about twenty seconds. ' +
      'The date range is applied after download because the server ignores it, so a narrow range costs the same.',
    schema: { from: dateArg.optional(), to: dateArg.optional() },
    run: ({ from, to }) => guard(async () => {
      const { client, exportDir } = await context();
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const result = await exportTimesheet(client, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
      mkdirSync(exportDir, { recursive: true });
      const path = `${exportDir}/${result.filename}`;
      writeFileSync(path, result.bytes);

      const bySituation: Record<string, number> = {};
      let hours = 0;
      const dates: string[] = [];
      for (const r of result.records) {
        const s = r['Situação'] ?? '(none)';
        bySituation[s] = (bySituation[s] ?? 0) + 1;
        hours += hoursOf(r);
        if (r['Data início']) dates.push(r['Data início']!);
      }
      const sortable = (d: string) => `${d.slice(6)}${d.slice(3, 5)}${d.slice(0, 2)}`;
      dates.sort((a, b) => sortable(a).localeCompare(sortable(b)));
      return {
        ok: true, file: path, entries: result.records.length, exportedBeforeFilter: result.totalBeforeFilter,
        hours: Number(hours.toFixed(1)), firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null,
        bySituation,
        note: 'Scoped to the signed-in user. Open the file for per-entry detail.',
      };
    }),
  },
];
