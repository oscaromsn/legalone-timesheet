import {
  contatoEscritorio,
  linkTo,
  type Contato,
  type Link,
  type LegalOneTimesheet,
  type Processo,
} from './client.ts';
import { classifyState, firmConfig } from './config.ts';

/**
 * Decides what a timesheet line should be booked against.
 *
 * The client is mechanism; this is policy. Everything here encodes a rule that
 * cost real time to discover, so the rules are stated where they are applied
 * rather than left for the next caller to rediscover.
 */

export const CNJ_PATTERN = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

/**
 * Every outcome is explicit. A resolver that guesses when it is unsure books
 * hours against the wrong client, and nothing downstream catches that — so
 * ambiguity and absence are results to be returned, never resolved by picking.
 */
export type Resolution =
  | { kind: 'internal'; link: Link }
  | { kind: 'linked'; link: Link; processo: Processo; via: 'cnj' | 'name' }
  | { kind: 'ambiguous'; candidates: Processo[]; reason: string }
  | { kind: 'matter-missing'; contato: Contato; cnj: string | null; clientName: string }
  /*
   * The search could not have found this, so its absence is not a finding.
   *
   * Distinct from `escalate` on purpose. "Not registered — administrative has to
   * create it" is a claim about the firm's records; on an installation with no alias
   * table it was a claim about this installation, made in the register's voice, about
   * clients registered for years. Naming the difference is what lets a plan run before
   * a configuration exists without any of its misses being believed.
   */
  /* Bound by configuration rather than found by searching. */
  | { kind: 'bound'; link: Link; head: string }
  | { kind: 'unconfigured'; reason: string; clientName: string | null }
  | { kind: 'escalate'; reason: string; clientName: string | null };

/*
 * Read per call, not captured at import. The configuration is a file a person edits
 * — through setup, or through an agent that just wrote one — and a module-level
 * constant would serve the table that existed when the process started. That is not
 * a stale cache: it is hours booked against the previous alias target, with both the
 * write and the report succeeding.
 */
const aliases = (): Record<string, string> => firmConfig().aliases;
const internalPrefixes = (): string[] => firmConfig().internal.prefixes;
const boundMatters = (): Record<string, { matterId: number; label: string }> =>
  firmConfig().matters ?? {};

/** The client name a line is about: the segment before the first em dash or colon. */
export const clientNameOf = (description: string): string | null => {
  const head = description.split(/[—:]/)[0]?.trim();
  return head && head.length > 1 ? head : null;
};

/**
 * Names to try, most specific first.
 *
 * Lines routinely qualify the client with a matter or person — "Acme / Ana",
 * "J. Ribeiro — Acme" — and the qualified form matches neither the alias
 * table nor the contact register. Trying the qualifier-stripped form as well is
 * what keeps a registered client from being reported as missing.
 */
export const candidateNames = (head: string): string[] => {
  const forms = [head, head.split('/')[0]!.trim(), head.split('(')[0]!.trim()];
  const table = aliases();
  const withAliases = forms.flatMap((form) => (table[form] ? [table[form]!, form] : [form]));
  return [...new Set(withAliases.filter((f) => f.length > 1))];
};

/** Applies the alias table. Registered names drift from the ones timesheets use. */
export const canonicalName = (name: string): string => aliases()[name] ?? name;

export const isInternal = (description: string): boolean =>
  internalPrefixes().some((prefix) => description.trimStart().startsWith(prefix));

export async function resolveTarget(
  client: LegalOneTimesheet,
  description: string,
): Promise<Resolution> {
  /*
   * An unconfigured installation does not fail here, it answers wrongly: with no
   * alias table every name is passed through unchanged, the search misses, and the
   * line comes back `escalate` — "not registered, administrative has to create it" —
   * about a client registered for years.
   *
   * This used to refuse the whole plan for that reason, which was the right instinct
   * and the wrong remedy: it also refused every line the alias table has no bearing
   * on, and it refused for template placeholders that classification never reads. The
   * verdict is labelled instead. Nothing here is believed that should not be, and the
   * report that names which heads are unresolvable is exactly the evidence the alias
   * decisions need.
   */
  const state = classifyState();
  if (isInternal(description)) {
    return state.internal
      ? { kind: 'internal', link: contatoEscritorio() }
      : {
          kind: 'unconfigured',
          reason: 'internal work, but defaults.contatoEscritorioId is unset, so there is nothing to link it to',
          clientName: null,
        };
  }

  const cnj = description.match(CNJ_PATTERN)?.[0] ?? null;
  const rawName = clientNameOf(description);
  const clientName = rawName ? canonicalName(rawName) : null;

  /*
   * CNJ first, name second — the inverse of how a person searches.
   * A name search misses any matter whose Cliente is not the party the work is
   * "about": a company's criminal case is filed under its individual defendant,
   * so searching the company name never returns it. The CNJ is unambiguous when present.
   */
  if (cnj) {
    const exact = (await client.searchProcessos(cnj)).filter((p) => p.cnj === cnj);
    if (exact.length === 1) {
      return { kind: 'linked', link: linkTo(exact[0]!), processo: exact[0]!, via: 'cnj' };
    }
    if (exact.length > 1) {
      return { kind: 'ambiguous', candidates: exact, reason: `${exact.length} matters share CNJ ${cnj}` };
    }
    // Known number, no matter: the client may still exist, which decides
    // between "register the matter" and "escalate to administrative".
    return clientName
      ? await missingMatter(client, clientName, cnj)
      : { kind: 'escalate', reason: `no matter for ${cnj} and no client name in the line`, clientName: null };
  }

  if (!clientName) return { kind: 'escalate', reason: 'no CNJ and no client name in the line', clientName: null };

  /*
   * A standing decision about this head, applied without a search.
   *
   * Only reached when the line carries no CNJ: a case number identifies one matter
   * and a binding identifies a head, so the more specific of the two wins. The label
   * travels with the link, so nothing has to read the matter back to name it.
   */
  const bound = boundMatters()[rawName!];
  if (bound) {
    return {
      kind: 'bound',
      link: { kind: 'processo', id: bound.matterId, text: bound.label },
      head: rawName!,
    };
  }

  const byName = await firstNonEmpty(candidateNames(rawName!), (n) => client.searchProcessos(n));
  if (byName.length === 1) {
    return { kind: 'linked', link: linkTo(byName[0]!), processo: byName[0]!, via: 'name' };
  }
  if (byName.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: byName,
      reason: `"${clientName}" matches ${byName.length} matters; a line with no CNJ cannot choose between them`,
    };
  }
  return await missingMatter(client, clientName, null);
}

async function firstNonEmpty<T>(names: string[], search: (name: string) => Promise<T[]>): Promise<T[]> {
  for (const name of names) {
    const hits = await search(name);
    if (hits.length > 0) return hits;
  }
  return [];
}

async function missingMatter(
  client: LegalOneTimesheet,
  clientName: string,
  cnj: string | null,
): Promise<Resolution> {
  const contatos = await firstNonEmpty(candidateNames(clientName), (n) => client.searchContatos(n));
  if (contatos.length === 0) {
    /*
     * Absent alias table, so this name was searched exactly as the timesheet wrote it.
     * Legal One files under registered names — "Beatriz Salgado" is filed under ORIONPAY
     * — so a miss here says nothing about whether the client exists.
     */
    if (!classifyState().aliasTable) {
      return {
        kind: 'unconfigured',
        reason:
          `"${clientName}" was searched literally: this installation has no alias table, ` +
          'so a name the timesheet uses cannot be mapped to the name Legal One files it under',
        clientName,
      };
    }
    return {
      kind: 'escalate',
      reason: `"${clientName}" is not registered as a contact — administrative has to create it first`,
      clientName,
    };
  }
  if (contatos.length > 1) {
    return {
      kind: 'escalate',
      reason: `"${clientName}" matches ${contatos.length} contacts; pick one before creating a matter`,
      clientName,
    };
  }
  return { kind: 'matter-missing', contato: contatos[0]!, cnj, clientName };
}

export interface PlannedEntry {
  date: string;
  startTime: string;
  endTime: string;
  description: string;
  resolution: Resolution;
}

/** Classifies a batch without writing anything. Run this before any logging. */
export async function planEntries(
  client: LegalOneTimesheet,
  entries: Array<{ date: string; startTime: string; endTime: string; description: string }>,
): Promise<PlannedEntry[]> {
  const cache = new Map<string, Resolution>();
  const planned: PlannedEntry[] = [];

  for (const entry of entries) {
    // Resolution depends only on the CNJ or client name, so identical targets
    // are resolved once rather than once per line.
    const key = entry.description.match(CNJ_PATTERN)?.[0] ?? clientNameOf(entry.description) ?? entry.description;
    const cached = cache.get(key) ?? (await resolveTarget(client, entry.description));
    cache.set(key, cached);
    planned.push({ ...entry, resolution: cached });
  }

  return planned;
}
