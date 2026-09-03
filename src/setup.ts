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
  for (const id of [...matterIds].slice(0, maxMatters)) {
    let m: Record<string, string> | null = null;
    for (const kind of ['processo', 'incidente'] as const) {
      try { m = await client.readMatter(id, kind); break; } catch { /* try the other path */ }
    }
    if (!m) { unreadable += 1; continue; }
    sampledMatters.push(id);
    escritorioOrigem.add(m['EscritorioOrigemId'], m['EscritorioOrigemText']);
    escritorioResponsavel.add(m['EscritorioResponsavelId'], m['EscritorioResponsavelText']);
    responsavel.add(m['Responsavel.EnvolvidoId'], m['Responsavel.EnvolvidoText']);
    posicao.add(m['Responsavel.PosicaoEnvolvidoId'], m['Responsavel.PosicaoEnvolvidoText']);
    natureza.add(m['NaturezaId'], m['NaturezaText']);
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} linked record(s) could not be read as a processo or incidente, and were skipped.`);
  }

  const findings = [
    finding('contatoEscritorioId', 'Firm contact (where internal time is booked)', contatoEscritorio),
    finding('escritorioId', 'Escritório', escritorioOrigem),
    finding('responsavelId', 'Responsável', responsavel),
    finding('responsavelPosicaoId', 'Posição do responsável', posicao),
    finding('naturezaId', 'Natureza', natureza),
    finding('executanteId', 'Executante (you)', executante),
    finding('areaId', 'Área', area),
    finding('tabelaValoresId', 'Tabela de valores', tabela),
    finding('valorHoraCobranca', 'Hourly rate', rate),
  ];

  /*
   * `interview.ts` collapses origem and responsável into one `escritorioId`. That
   * holds on a firm where they agree, and quietly books against the wrong one where
   * they do not — so it is checked rather than assumed.
   */
  const origem = escritorioOrigem.candidates()[0]?.value;
  const respEscritorio = escritorioResponsavel.candidates()[0]?.value;
  if (origem && respEscritorio && origem !== respEscritorio) {
    warnings.push(
      `EscritorioOrigem (${origem}) and EscritorioResponsavel (${respEscritorio}) differ on this tenant, ` +
        'but aliases.json has one escritorioId for both. Decide which one this firm books against.',
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
