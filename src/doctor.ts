/*
 * Checks whether this client's assumptions actually hold on the tenant in front of
 * it.
 *
 * Every parsing rule here was derived from one Legal One install. That is fine until
 * someone else runs it, and the failure mode is what makes this worth writing: when
 * an assumption breaks, the dominant outcome is not an exception. It is a plausible
 * wrong answer. A renamed grid column yields `null` where a CNJ should be, and the
 * resolver concludes the matter does not exist — then offers to create it, and
 * matters cannot be deleted. A 12-hour clock empties the duplicate check. A status id
 * that means something else moves an entry into billing.
 *
 * So the checks below are ordered by how silent the failure is, not by how likely.
 * Most of them are wiring rather than invention: `parseLookups`, `generateTemplate`
 * and `discover` were each written to answer one of these questions and, until now,
 * had no caller anywhere.
 */
import {
  ENTRY_STATUS,
  parseLookups,
  type Contato,
  type LegalOneTimesheet,
  type Processo,
  type TimeEntryRecord,
} from './client.ts';
import { keyOfRecord } from './execute.ts';
import { MATTER_LOOKUPS } from './interview.ts';
import { discover } from './setup.ts';
import { generateTemplate } from './template.ts';

export type Verdict = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  verdict: Verdict;
  /** What was observed, in enough detail to act on. */
  detail: string;
}

export interface Diagnosis {
  checks: Check[];
  ok: number;
  warn: number;
  fail: number;
}

export interface DoctorOptions {
  /** A date range with entries in it. Defaults to the last `days`. */
  from?: string;
  to?: string;
  /**
   * How far back to look. Every check reads real records, so this is the whole cost
   * of the run — a wide window is a slow diagnosis, and a caller on a clock (an MCP
   * client, say) should narrow it rather than wait.
   */
  days?: number;
  /** A matter id to read the form assumptions off. Discovered from entries if absent. */
  matterId?: number;
  installedTemplate?: Array<[string, string]>;
  now?: Date;
}

const ddmmyyyy = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/** Columns the parsers key on. A missing one yields null, never an error. */
const REQUIRED_COLUMNS = {
  entries: ['Descrição', 'Data/hora início', 'Data/hora término', 'Executante'],
  matters: ['Processo', 'Cliente', 'Título'],
  contacts: ['CPF/CNPJ'],
} as const;

const missingColumns = (rows: Array<{ columns: Record<string, string> }>, required: readonly string[]): string[] => {
  if (rows.length === 0) return [];
  const present = new Set(Object.keys(rows[0]!.columns));
  return required.filter((c) => !present.has(c));
};

export async function diagnose(client: LegalOneTimesheet, options: DoctorOptions = {}): Promise<Diagnosis> {
  const checks: Check[] = [];
  const add = (name: string, verdict: Verdict, detail: string) => checks.push({ name, verdict, detail });
  /** One broken check must not hide the rest. */
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { add(name, 'fail', `check itself failed: ${(e as Error).message.slice(0, 140)}`); }
  };

  const now = options.now ?? new Date();
  const days = options.days ?? 120;
  const from = options.from ?? ddmmyyyy(new Date(now.getTime() - days * 86_400_000));
  const to = options.to ?? ddmmyyyy(now);

  let entries: TimeEntryRecord[] = [];
  let matters: Processo[] = [];
  let contacts: Contato[] = [];

  await run('grid parses at all', async () => {
    entries = await client.listEntries(from, to);
    const html = await client.searchRaw(from, to, 1);
    const parsed = entries.length;
    /*
     * Telling "no results" apart from "the markup changed" needs a positive signal,
     * and counting rows is not one: a header, a filter row and an empty-state row all
     * look like rows. Two earlier attempts failed on exactly that.
     *
     * A record carries a link to its own detail page. If the page holds those and the
     * parser found nothing, the row markup moved; if it holds none, the range is
     * simply empty.
     */
    const recordLinks = (html.match(/HorasTrabalhadas\/Details\/\d+/g) ?? []).length;
    if (parsed > 0) add('grid parses at all', 'ok', `${parsed} entries parsed from ${from}–${to}`);
    else if (recordLinks > 0) add('grid parses at all', 'fail', `the page links ${recordLinks} record(s) but the parser matched none; the row markup differs`);
    else add('grid parses at all', 'warn', `no entries between ${from} and ${to}, so this could not be checked — widen the range`);
  });

  await run('grid columns', async () => {
    // One page each: this needs column names, not the firm's whole register.
    matters = await client.searchProcessos('a', 1);
    contacts = await client.searchContatos('a', 1);
    const gaps = [
      ...missingColumns(entries, REQUIRED_COLUMNS.entries).map((c) => `entries:${c}`),
      ...missingColumns(matters, REQUIRED_COLUMNS.matters).map((c) => `matters:${c}`),
      ...missingColumns(contacts, REQUIRED_COLUMNS.contacts).map((c) => `contacts:${c}`),
    ];
    add('grid columns', gaps.length === 0 ? 'ok' : 'fail',
      gaps.length === 0
        ? 'every column the parsers key on is present'
        : `missing: ${gaps.join(', ')} — these parse to null, and null reads as absence`);
  });

  await run('pagination', async () => {
    const first = await client.searchRaw(from, to, 1);
    const second = await client.searchRaw(from, to, 2);
    const ids = (html: string) => [...html.matchAll(/HorasTrabalhadas\/Details\/(\d+)/g)].map((m) => m[1]).join(',');
    const a = ids(first), b = ids(second);
    if (!b) add('pagination', 'ok', 'a single page covers this range');
    else if (a === b) add('pagination', 'fail', 'page 2 returns page 1; the pager is not advancing and loops read duplicates');
    else add('pagination', 'ok', 'the Page parameter advances');
  });

  await run('date order', async () => {
    // A first component above 12 can only be a day, which settles the order without
    // writing anything. If nothing in range exceeds 12, say so rather than guess.
    const dates = entries.map((e) => (e.inicio ?? '').slice(0, 10)).filter(Boolean);
    const unambiguous = dates.find((d) => Number(d.slice(0, 2)) > 12);
    if (unambiguous) add('date order', 'ok', `day-first confirmed by ${unambiguous}`);
    else add('date order', 'warn',
      `no date in range has a first component above 12, so dd/MM vs MM/dd is unresolved. ` +
      `The client sends dd/MM/yyyy; a tenant reading MM/dd files hours in the wrong month.`);
  });

  await run('time format', async () => {
    const unreadable = entries.filter((e) => keyOfRecord(e) === null);
    if (entries.length === 0) add('time format', 'warn', 'no entries to sample');
    else if (unreadable.length === 0) add('time format', 'ok', `all ${entries.length} timestamps parse as dd/MM/yyyy HH:mm:ss`);
    else add('time format', 'fail',
      `${unreadable.length}/${entries.length} timestamps unreadable (e.g. "${unreadable[0]!.inicio}"); ` +
      `the duplicate check cannot run and executePlan will refuse to write`);
  });

  await run('status ids', async () => {
    const rows = await client.lookup('/TimeSheet/HorasTrabalhadas/LookupSituacao', undefined, { pageSize: '100' });
    const byId = new Map(rows.map((r) => [String(r['Id'] ?? ''), String(r['Value'] ?? '')]));
    const drift = Object.entries(ENTRY_STATUS)
      .filter(([, id]) => !byId.has(String(id)))
      .map(([name, id]) => `${name}=${id}`);
    add('status ids', drift.length === 0 ? 'ok' : 'warn',
      drift.length === 0
        ? `${rows.length} statuses, and every id the code names exists here`
        : `ids not present on this tenant: ${drift.join(', ')} — setEntryStatus resolves by label, so this is informational`);
  });

  await run('matter lookups', async () => {
    const id = options.matterId ?? matters[0]?.id;
    if (!id) { add('matter lookups', 'warn', 'no matter available to read the form from'); return; }
    const { html } = await client.readFormPairs(`/processos/Processos/Edit/${id}`);
    const declared = parseLookups(html);
    const urls = declared.map((w) => w.contentUrl ?? '');
    const missing = Object.entries(MATTER_LOOKUPS)
      .filter(([, l]) => !urls.some((u) => u.toLowerCase().includes(l.path.toLowerCase())))
      .map(([k, l]) => `${k} (${l.path})`);
    add('matter lookups', missing.length === 0 ? 'ok' : 'fail',
      missing.length === 0
        ? `${declared.length} lookups declared, ${declared.filter((w) => w.kind === 'lookupTree').length} hierarchical, and the interview's three are among them`
        : `the form declares no endpoint matching: ${missing.join(', ')} — the interview would show empty pick lists`);
  });

  await run('entry form shape', async () => {
    const candidate = await generateTemplate(client, options.installedTemplate ?? []);
    const structural = candidate.warnings.filter((w) => w.includes('row') || w.includes('GUID'));
    add('entry form shape', structural.length === 0 ? 'ok' : 'fail',
      structural.length === 0
        ? `${candidate.pairs.length} fields, one row of each collection as the template model assumes`
        : structural.join(' | '));
  });

  await run('configured ids', async () => {
    const found = await discover(client, { days, maxEntries: 10, maxMatters: 8, now });
    const unresolved = found.findings.filter((f) => f.best === null).map((f) => f.label);
    const contested = found.findings.filter((f) => f.candidates.length > 1).map((f) => f.label);
    /*
     * Nothing sampled is not agreement. Reporting "all values agreed" over zero
     * records would be a check that passes because it never ran, which is worse than
     * one that fails.
     */
    if (found.findings.length === 0 || found.entriesSampled === 0) {
      add('configured ids', 'warn',
        `nothing to check: ${found.entriesSampled} entries and ${found.mattersSampled} matters in range. Widen the window.`);
    } else if (unresolved.length > 0) {
      add('configured ids', 'fail', `nothing found for: ${unresolved.join(', ')}`);
    } else if (contested.length > 0) {
      add('configured ids', 'warn', `the firm's own records disagree on: ${contested.join(', ')} — read the evidence before adopting`);
    } else {
      add('configured ids', 'ok', `all ${found.findings.length} values agreed across ${found.entriesSampled} entries and ${found.mattersSampled} matters`);
    }
  });

  return {
    checks,
    ok: checks.filter((c) => c.verdict === 'ok').length,
    warn: checks.filter((c) => c.verdict === 'warn').length,
    fail: checks.filter((c) => c.verdict === 'fail').length,
  };
}

const MARK: Record<Verdict, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export const format = (d: Diagnosis): string => {
  const lines = d.checks.map((c) => `  ${MARK[c.verdict]}  ${c.name.padEnd(20)} ${c.detail}`);
  lines.push('', `${d.ok} ok, ${d.warn} warnings, ${d.fail} failures`);
  if (d.fail > 0) lines.push('', 'A failure means an assumption this client is built on does not hold here. Do not write until it is understood.');
  return lines.join('\n');
};
