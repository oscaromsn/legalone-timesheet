/*
 * Discovers what a firm's configuration should be, by reading what the firm has
 * already recorded.
 *
 * Every value in `aliases.json` is an internal Legal One id — escritório,
 * responsável, natureza, área, tabela de valores — and none of them can be
 * shipped, guessed, or reasonably typed in by a lawyer. They do, however, already
 * exist: they are stamped on every timesheet entry and every matter the firm has
 * filed. So this reads them back rather than asking.
 *
 * Two rules shape the whole file.
 *
 * **It writes nothing.** Discovery and adoption are separate acts; this produces a
 * proposal with its evidence and stops. Booking hours against a wrong escritório
 * is invisible after the fact, so the decision stays with a person.
 *
 * **One record is not evidence.** A single sampled matter tells you that matter's
 * responsável, which on a real tenant is often not the firm default — the
 * responsável and the executante are frequently different people. Every finding
 * therefore carries how many records agreed and what else was seen.
 */
import type { LegalOneTimesheet } from './client.ts';
import { clientNameOf } from './resolver.ts';
import { firmConfig } from './config.ts';

const ENTRY_FORM = '/TimeSheet/HorasTrabalhadas/EditHoraTrabalhada';

/** One value seen in the firm's own records, and how often. */
export interface Candidate {
  value: string;
  /** The display half Legal One pairs with the id, where the form carries one. */
  text: string;
  count: number;
}

export interface Finding {
  /** The `aliases.json` key under `defaults` this fills. */
  key: string;
  label: string;
  /** The most common value, or null when nothing was found. */
  best: Candidate | null;
  /** Everything seen, most common first. A second entry here means a real choice. */
  candidates: Candidate[];
  /** Records that carried this field at all. */
  sampled: number;
}

export interface Discovery {
  entriesSampled: number;
  mattersSampled: number;
  findings: Finding[];
  /** Things a person has to look at before adopting any of this. */
  warnings: string[];
}

export interface DiscoverOptions {
  /** How far back to look for the firm's own entries. */
  days?: number;
  maxEntries?: number;
  maxMatters?: number;
  /** Today, injectable so the range is testable. */
  now?: Date;
}

const ddmmyyyy = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/** Field names on the entry form carry per-render GUIDs, so match on the last segment. */
const leafOf = (name: string): string => name.split('.').pop() ?? name;

const byLeaf = (pairs: Array<[string, string]>, leaf: string): string | null =>
  pairs.find(([name]) => leafOf(name) === leaf)?.[1] ?? null;

/** Accumulates `id → text` sightings so a mode can be taken with its distribution. */
class Tally {
  private readonly counts = new Map<string, { text: string; count: number }>();

  add(value: string | null | undefined, text: string | null | undefined): void {
    if (!value || value === '0') return;
    const seen = this.counts.get(value);
    if (seen) { seen.count += 1; if (!seen.text && text) seen.text = text; }
    else this.counts.set(value, { text: text ?? '', count: 1 });
  }

  candidates(): Candidate[] {
    return [...this.counts]
      .map(([value, { text, count }]) => ({ value, text, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  get sampled(): number {
    return [...this.counts.values()].reduce((n, c) => n + c.count, 0);
  }
}

const finding = (key: string, label: string, tally: Tally): Finding => {
  const candidates = tally.candidates();
  return { key, label, best: candidates[0] ?? null, candidates, sampled: tally.sampled };
};

/**
 * Reads the firm's own records and proposes a configuration.
 *
 * The walk is deliberately in this order: the user's timesheet entries name the
 * matters they actually book to, which is a far better sample than any free-text
 * search, and it needs no search term at all.
 */
export async function discover(
  client: LegalOneTimesheet,
  options: DiscoverOptions = {},
): Promise<Discovery> {
  const days = options.days ?? 90;
  const maxEntries = options.maxEntries ?? 25;
  const maxMatters = options.maxMatters ?? 20;
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000);

  const warnings: string[] = [];
  const entries = await client.listEntries(ddmmyyyy(from), ddmmyyyy(now));
  if (entries.length === 0) {
    return {
      entriesSampled: 0,
      mattersSampled: 0,
      findings: [],
      warnings: [
        `no timesheet entries in the last ${days} days, so there is nothing to read a configuration from. ` +
          'Either widen the range, or configure by choosing from the form lookups instead.',
      ],
    };
  }

  const executante = new Tally();
  const area = new Tally();
  const tabela = new Tally();
  const rate = new Tally();
  const contatoEscritorio = new Tally();
  const matterIds = new Set<number>();

  for (const entry of entries.slice(0, maxEntries)) {
    const { pairs } = await client.readFormPairs(`${ENTRY_FORM}/${entry.id}`);
    executante.add(byLeaf(pairs, 'ExecutanteId'), byLeaf(pairs, 'ExecutanteText'));
    area.add(byLeaf(pairs, 'AreaId'), byLeaf(pairs, 'AreaText'));
    tabela.add(byLeaf(pairs, 'TabelaValoresId'), byLeaf(pairs, 'TabelaValoresText'));
    rate.add(byLeaf(pairs, 'ValorHoraCobranca'), '');
    // An entry booked to a contact rather than a matter is internal work, and the
    // contact it names is the firm itself — the one place that id is observable.
    contatoEscritorio.add(byLeaf(pairs, 'VinculoContatoId'), byLeaf(pairs, 'VinculoContatoText'));
    const matter = byLeaf(pairs, 'VinculoGridId');
    if (matter && Number(matter) > 0) matterIds.add(Number(matter));
  }

  const escritorioOrigem = new Tally();
  const escritorioResponsavel = new Tally();
  const responsavel = new Tally();
  const posicao = new Tally();
  const natureza = new Tally();

  /*
   * A link on an entry names a record id, not necessarily a processo: incidentes
   * are linked the same way and live under a different path, and a matter can have
   * been removed since. Measured on a real tenant, one sampled id answered 404 on
   * the processo path. Sampling is best-effort by nature, so an unreadable record
   * is counted and skipped — losing the whole walk over one of them would be worse
   * than the missing sample.
   */
  const sampledMatters: number[] = [];
  let unreadable = 0;
  /** Matters whose origem and responsável escritórios actually differ. */
  const divergentEscritorio: number[] = [];
  for (const id of [...matterIds].slice(0, maxMatters)) {
    let m: Record<string, string> | null = null;
    for (const kind of ['processo', 'incidente'] as const) {
      try { m = await client.readMatter(id, kind); break; } catch { /* try the other path */ }
    }
    if (!m) { unreadable += 1; continue; }
    sampledMatters.push(id);
    escritorioOrigem.add(m['EscritorioOrigemId'], m['EscritorioOrigemText']);
    escritorioResponsavel.add(m['EscritorioResponsavelId'], m['EscritorioResponsavelText']);
    // Compared here, on the record, rather than between the two tallies later.
    const origem = m['EscritorioOrigemId'];
    const respEscritorio = m['EscritorioResponsavelId'];
    if (origem && respEscritorio && origem !== respEscritorio) divergentEscritorio.push(id);
    responsavel.add(m['Responsavel.EnvolvidoId'], m['Responsavel.EnvolvidoText']);
    posicao.add(m['Responsavel.PosicaoEnvolvidoId'], m['Responsavel.PosicaoEnvolvidoText']);
    natureza.add(m['NaturezaId'], m['NaturezaText']);
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} linked record(s) could not be read as a processo or incidente, and were skipped.`);
  }

  const findings = [
    finding('contatoEscritorioId', 'Firm contact (where internal time is booked)', contatoEscritorio),
    finding('escritorioOrigemId', 'Escritório de origem', escritorioOrigem),
    finding('escritorioResponsavelId', 'Escritório responsável', escritorioResponsavel),
    finding('responsavelId', 'Responsável', responsavel),
    finding('responsavelPosicaoId', 'Posição do responsável', posicao),
    finding('naturezaId', 'Natureza', natureza),
    finding('executanteId', 'Executante (you)', executante),
    finding('areaId', 'Área', area),
    finding('tabelaValoresId', 'Tabela de valores', tabela),
    finding('valorHoraCobranca', 'Hourly rate', rate),
  ];

  /*
   * Whether the two escritórios diverge is a question about records, not about
   * modes — and this compared modes until a tenant proved the difference. There,
   * one sampled matter had no origem, so the two tallies were drawn from sets of
   * different sizes and their most-common values disagreed, while all fourteen
   * matters had the two fields identical. Identical distributions do not imply
   * identical pairs, and neither does the reverse. Compare the pair, on the record.
   */
  if (divergentEscritorio.length > 0) {
    warnings.push(
      `${divergentEscritorio.length} of ${sampledMatters.length} matters file origem and responsável under ` +
        `different escritórios (e.g. matter ${divergentEscritorio[0]}). Configure the two separately and ` +
        'check both, rather than assuming one value serves.',
    );
  }

  for (const f of findings) {
    if (f.best === null) {
      warnings.push(`${f.label}: nothing found in the sampled records — it has to be chosen by hand.`);
    } else if (f.sampled === 1) {
      warnings.push(`${f.label}: only one record carried it, so this is a sample of one, not a firm default.`);
    } else if (f.candidates.length > 1) {
      const spread = f.candidates.map((c) => `${c.value}×${c.count}`).join(', ');
      warnings.push(`${f.label}: the firm's records disagree (${spread}). The most common is proposed, not chosen.`);
    }
  }

  if (sampledMatters.length === 0) {
    warnings.push('none of the sampled entries was booked to a matter, so nothing about matters could be read.');
  }

  return { entriesSampled: Math.min(entries.length, maxEntries), mattersSampled: sampledMatters.length, findings, warnings };
}

/** Renders a discovery for a person to read. Aliases are never part of it. */
export const format = (d: Discovery): string => {
  const lines: string[] = [
    `sampled ${d.entriesSampled} timesheet entries and ${d.mattersSampled} matters`,
    '',
  ];
  for (const f of d.findings) {
    const best = f.best ? `${f.best.value}${f.best.text ? `  ${f.best.text}` : ''}` : '(not found)';
    const agreement = f.best ? `  [${f.best.count}/${f.sampled}]` : '';
    lines.push(`  ${f.label.padEnd(44)} ${best}${agreement}`);
    for (const alt of f.candidates.slice(1)) {
      lines.push(`  ${''.padEnd(44)} also: ${alt.value}${alt.text ? `  ${alt.text}` : ''} ×${alt.count}`);
    }
  }
  if (d.warnings.length > 0) {
    lines.push('', 'before adopting any of this:');
    for (const w of d.warnings) lines.push(`  - ${w}`);
  }
  /*
   * The alias table maps a timesheet's names to registered ones. It cannot be
   * derived — a wrong alias books hours against the wrong client and nothing
   * surfaces it — so setup leaves it empty and says so rather than inventing one.
   */
  lines.push('', 'aliases are not discovered: they are billing decisions, and stay empty until written by hand.');
  return lines.join('\n');
};

/*
 * ---------------------------------------------------------------------------
 * Aliases, which this file spent its whole life refusing to discover.
 *
 * The refusal was right for the reason it gave: an alias is a billing decision,
 * it applies to every future line whose head matches, and a wrong one books hours
 * against the wrong client with nothing to surface it. What changed is not that
 * judgement but who exercises it — a lawyer talking to an agent cannot open the
 * file, so "written by hand" means "never written".
 *
 * So this proposes, and the refusals below are the whole design. Pairing the head of
 * a description with the registered `Cliente` of the matter it was booked to is a
 * *per-matter* observation being generalised into a *global* rewrite, and most of the
 * ways that goes wrong are silent:
 *
 *   `Reunião: ...`, `Audiência — ...`, `TJSP — ...` are heads that are not clients at
 *   all. Pair one and every meeting line, for every client, resolves `linked` to
 *   whichever company happened to be first. Not `ambiguous`, not `escalate` —
 *   `linked`, with a confident plan a lawyer approves.
 *
 *   Frequency points the wrong way. Generic heads co-occur with everything, so they
 *   carry the highest counts. Count is evidence, never ranking.
 *
 *   On a criminal matter the registered client is the individual defendant, so
 *   pairing correctly yields company → individual — right for that matter and wrong
 *   for the next one the company files under its own name.
 * ---------------------------------------------------------------------------
 */

/** One proposed rewrite, with everything a person needs to judge it. */
export interface AliasCandidate {
  /** What the timesheet line says. */
  head: string;
  /** What Legal One files it under. */
  registered: string;
  entries: number;
  matters: number[];
  /** Verbatim lines this was read from, so the evidence is not a summary. */
  samples: Array<{ id: number; date: string; description: string }>;
  /** What a search for each returns today — the counterfactual the alias changes. */
  hitsForHead: number;
  hitsForRegistered: number;
}

export interface AliasDiscovery {
  candidates: AliasCandidate[];
  /** Heads deliberately not proposed, and why. Shown, because silence looks like absence. */
  refused: Array<{ head: string; reason: string }>;
  /** Heads whose entries were booked to no matter — a question, not a proposal. */
  unpaired: string[];
  entriesSampled: number;
}

const fold = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Reasons never to propose a head, checked before anything costs a request.
 *
 * Exported so a gate can measure the real rule rather than a copy of it: these are
 * the only thing standing between this feature and a wrong-answer generator.
 */
export const aliasRefusal = (head: string, registered: string, distinctClients: number): string | null => {
  if (distinctClients > 1) {
    return `appears with ${distinctClients} different registered clients, so it names work, not a party`;
  }
  if (firmConfig().internal.prefixes.some((p) => head.startsWith(p))) {
    return 'is an internal-work prefix, which is booked to the firm rather than aliased';
  }
  if (head.length < 3) return 'is too short to identify anyone';
  if (/^\d{1,2}[/.-]\d{1,2}/.test(head) || /^\d{7}-\d{2}/.test(head)) return 'is a date or a case number, not a name';
  if (/[(,]| e /.test(registered)) {
    return `the registered name carries a procedural role or several parties ("${registered}"), which no contact search matches`;
  }
  if (fold(registered).includes(fold(head))) return 'is already contained in the registered name, so the search finds it without an alias';
  return null;
};

/**
 * Proposes the alias table from entries the firm has already booked.
 *
 * Returns candidates only where the head and the registered name genuinely differ and
 * nothing above refused them. Nothing here decides: every survivor is meant to be
 * approved one at a time, against its own evidence.
 */
export async function discoverAliases(
  client: LegalOneTimesheet,
  options: DiscoverOptions = {},
): Promise<AliasDiscovery> {
  const days = options.days ?? 90;
  const maxEntries = options.maxEntries ?? 60;
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - days * 86_400_000);

  const entries = await client.listEntries(ddmmyyyy(from), ddmmyyyy(now));
  const sampled = entries.slice(0, maxEntries);
  if (sampled.length === 0) return { candidates: [], refused: [], unpaired: [], entriesSampled: 0 };

  /** head → the matters its lines were booked to, and the lines themselves. */
  const byHead = new Map<string, { matters: Set<number>; samples: AliasCandidate['samples'] }>();
  const unpaired = new Set<string>();

  for (const entry of sampled) {
    const head = clientNameOf(entry.descricao ?? '');
    if (!head) continue;
    const { pairs } = await client.readFormPairs(`${ENTRY_FORM}/${entry.id}`);
    const matter = Number(byLeaf(pairs, 'VinculoGridId') ?? '');
    if (!Number.isInteger(matter) || matter <= 0) { unpaired.add(head); continue; }
    const slot = byHead.get(head) ?? { matters: new Set<number>(), samples: [] };
    slot.matters.add(matter);
    if (slot.samples.length < 3) {
      slot.samples.push({ id: entry.id, date: (entry.inicio ?? '').slice(0, 10), description: entry.descricao ?? '' });
    }
    byHead.set(head, slot);
  }

  /** Matters are read once each, however many heads point at them. */
  const clientOf = new Map<number, string>();
  for (const id of new Set([...byHead.values()].flatMap((s) => [...s.matters]))) {
    for (const kind of ['processo', 'incidente'] as const) {
      try {
        const m = await client.readMatter(id, kind);
        const name = m['Cliente.EnvolvidoText'];
        if (name) clientOf.set(id, name);
        break;
      } catch { /* try the other path */ }
    }
  }

  const candidates: AliasCandidate[] = [];
  const refused: Array<{ head: string; reason: string }> = [];

  for (const [head, slot] of byHead) {
    const names = [...new Set([...slot.matters].map((id) => clientOf.get(id)).filter((n): n is string => !!n))];
    if (names.length === 0) { unpaired.add(head); continue; }
    const registered = names[0]!;
    if (fold(registered) === fold(head) && names.length === 1) continue; // no drift to correct

    const reason = aliasRefusal(head, registered, names.length);
    if (reason) { refused.push({ head, reason }); continue; }

    /*
     * The last refusal costs two requests, so it runs last: if searching the head
     * already finds exactly one matter, the alias cannot improve anything and can
     * only redirect a search that works today.
     */
    const hitsForHead = (await client.searchProcessos(head, 1)).length;
    if (hitsForHead === 1) {
      refused.push({ head, reason: 'already finds exactly one matter without an alias' });
      continue;
    }
    const hitsForRegistered = (await client.searchProcessos(registered, 1)).length;
    candidates.push({
      head,
      registered,
      entries: slot.samples.length,
      matters: [...slot.matters],
      samples: slot.samples,
      hitsForHead,
      hitsForRegistered,
    });
  }

  return { candidates, refused, unpaired: [...unpaired], entriesSampled: sampled.length };
}
