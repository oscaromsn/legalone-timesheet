import { z } from 'zod';
import firm from './aliases.json';
import template from './template.json';

/**
 * Legal One (NovaJus) timesheet client.
 *
 * Derived from captured browser traffic, not from a published API. Legal One's
 * timesheet module is server-rendered ASP.NET MVC: reads return HTML, writes are
 * form-urlencoded POSTs. There is no anti-forgery token, so the session cookie is
 * the entire credential.
 *
 * Create and update share one endpoint. An empty `Id` with no path segment creates;
 * `Id=<n>` with `/{id}` in the path updates.
 */

/**
 * Tenant URL, from LEGALONE_BASE_URL or the `baseUrl` option.
 *
 * Deliberately not defaulted to a tenant. A baked-in default silently sends another
 * firm's install at the original tenant, which fails as a login redirect rather than
 * anything that names the real problem.
 */
const BASE = process.env['LEGALONE_BASE_URL'];
const PATH = '/TimeSheet/HorasTrabalhadas';

/** Legal One silently rejects the whole form when the description exceeds this. */
export const DESCRIPTION_MAX = 500;

/** Timesheet approval states, as served by /TimeSheet/HorasTrabalhadas/LookupSituacao. */
export const ENTRY_STATUS = {
  aprovada: 1,
  disponivelParaAprovacao: 2,
  pendente: 3,
  recusada: 4,
  disponivelParaFinanceiro: 5,
  lancadaNoFinanceiro: 6,
} as const;

export type EntryStatus = keyof typeof ENTRY_STATUS;

const hhmmss = /^\d{2}:\d{2}:\d{2}$/;
const ddmmyyyy = /^\d{2}\/\d{2}\/\d{4}$/;

/**
 * What the entry is billed against. Legal One models this as a discriminated
 * union keyed on `TipoVinculo`: `0` populates the Contato pair and leaves the
 * Grid pair empty, `1` does the reverse. Sending both, or neither, is not a
 * shape the form ever produces.
 */
export const LinkSchema = z.discriminatedUnion('kind', [
  /** A contact — used for internal work with no client matter. */
  z.object({ kind: z.literal('contato'), id: z.number().int().positive(), text: z.string().default('') }),
  /** A matter. `id` is the processo record id, not the CNJ. */
  z.object({ kind: z.literal('processo'), id: z.number().int().positive(), text: z.string().default('') }),
]);

export type Link = z.input<typeof LinkSchema>;

/**
 * The firm's own contact — where internal "Escritório" time is booked.
 *
 * Read from `aliases.json` rather than hardcoded: the id is tenant-specific, and
 * that file is the one place firm identity lives.
 */
export const CONTATO_ESCRITORIO: Link = {
  kind: 'contato',
  id: Number(firm.defaults.contatoEscritorioId),
  text: firm.defaults.contatoEscritorioText,
};

/** Builds the link for a matter returned by `resolveProcesso`/`searchProcessos`. */
export const linkTo = (processo: Processo): Link => ({
  kind: 'processo',
  id: processo.id,
  text: processo.pasta ?? '',
});

export const TimeEntrySchema = z
  .object({
    /** dd/MM/yyyy — Legal One rejects ISO dates. */
    date: z.string().regex(ddmmyyyy, 'expected dd/MM/yyyy'),
    startTime: z.string().regex(hhmmss, 'expected HH:mm:ss'),
    endTime: z.string().regex(hhmmss, 'expected HH:mm:ss'),
    description: z.string().min(1).max(DESCRIPTION_MAX),
    /**
     * Billed duration. Defaults to the elapsed time; set it only to deliberately
     * bill something other than the wall-clock span — that divergence is what the
     * "duração considerada" column exists to record.
     */
    consideredDuration: z.string().regex(hhmmss).optional(),
    /**
     * Free-text notes, no length limit. Where description overflow goes: the
     * description caps at 500 characters, this does not.
     */
    observations: z.string().optional(),
    /** Defaults to the firm contact — correct for internal work, wrong for anything billable. */
    link: LinkSchema.optional(),
  })
  .refine((e) => toSeconds(e.endTime) > toSeconds(e.startTime), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export type TimeEntry = z.infer<typeof TimeEntrySchema>;

const toSeconds = (t: string): number => {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const toDuration = (seconds: number): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
};

/**
 * The form binds collections by GUID key, e.g. `Vinculos[<guid>].VinculoContatoId`.
 * The values are generated per render and never persisted — the model binder only
 * requires that keys referring to the same row agree. Fresh GUIDs each call is
 * correct and avoids any chance of colliding with a live form.
 */
const bindTemplate = (): Array<[string, string]> => {
  const ids = { VINC: crypto.randomUUID(), EXEC: crypto.randomUUID(), CLAS: crypto.randomUUID() };
  const fill = (s: string) => s.replace(/\{(VINC|EXEC|CLAS)\}/g, (_, k: keyof typeof ids) => ids[k]);
  return (template as Array<[string, string]>).map(([k, v]) => [fill(k), fill(v)]);
};

const rowFields = (
  fields: Array<[string, string]>,
  duration: string,
  considered: string,
  link: z.output<typeof LinkSchema>,
): void => {
  const vinc = fields.find(([k]) => k.endsWith('Vinculos.Index'))?.[1];
  const clas = fields.find(([k]) => k.includes('.Classificacoes.Index'))?.[1];
  const prefix = `Vinculos[${vinc}].Classificacoes[${clas}]`;
  fields.push([`${prefix}.DuracaoOriginalHoraTrabalhada`, duration]);
  fields.push([`${prefix}.DuracaoConsiderada`, considered]);

  const isProcesso = link.kind === 'processo';
  fields.push([`Vinculos[${vinc}].TipoVinculo`, isProcesso ? '1' : '0']);
  fields.push([`Vinculos[${vinc}].VinculoContatoText`, isProcesso ? '' : link.text]);
  fields.push([`Vinculos[${vinc}].VinculoContatoId`, isProcesso ? '' : String(link.id)]);
  fields.push([`Vinculos[${vinc}].VinculoGridText`, isProcesso ? link.text : '']);
  fields.push([`Vinculos[${vinc}].VinculoGridId`, isProcesso ? String(link.id) : '']);
};

/**
 * Sets a field the caller must win on, replacing the template's value in place.
 *
 * Appending would post the key twice, and ASP.NET binds the *first* occurrence —
 * so `Observacoes`, which the template already carries as empty, lost every value
 * pushed after it. The save still returned 200 and the entry still saved; only the
 * observations were blank, which is exactly the failure this file is built to
 * prevent. Any future template addition would fail the same silent way, so set
 * every caller-supplied field through here rather than pushing.
 */
const setField = (fields: Array<[string, string]>, name: string, value: string): void => {
  const existing = fields.find(([k]) => k === name);
  if (existing) existing[1] = value;
  else fields.push([name, value]);
};

const buildBody = (entry: TimeEntry, id?: number): string => {
  const e = TimeEntrySchema.parse(entry);
  const duration = toDuration(toSeconds(e.endTime) - toSeconds(e.startTime));

  const fields = bindTemplate();
  setField(fields, 'Id', id ? String(id) : '');
  setField(fields, 'DtInicio', e.date);
  setField(fields, 'DtTermino', e.date);
  setField(fields, 'HrInicio', e.startTime);
  setField(fields, 'HrTermino', e.endTime);
  setField(fields, 'Duracao', duration);
  setField(fields, 'DescricaoHT', e.description);
  if (e.observations !== undefined) setField(fields, 'Observacoes', e.observations);
  setField(fields, 'ButtonSave', '1');
  setField(fields, 'LastFieldWithFocus', 'DescricaoHT');
  rowFields(fields, duration, e.consideredDuration ?? duration, e.link ?? LinkSchema.parse(CONTATO_ESCRITORIO));

  return new URLSearchParams(fields).toString();
};

export interface Processo {
  /** Internal record id — the `/processos/processos/details/{id}` key. */
  id: number;
  /** CNJ number, e.g. 1234567-89.2024.8.26.0100. */
  cnj: string | null;
  /** Folder label, e.g. "Proc - 0001234". */
  pasta: string | null;
  status: string | null;
  tipo: string | null;
  acao: string | null;
  /**
   * Client as registered on the matter, including its procedural role.
   * On an ação penal this is the defendant — the company the work is *about*
   * may not appear here at all. See `searchProcessos`.
   */
  cliente: string | null;
  contrario: string | null;
  jurisdicao: string | null;
  titulo: string | null;
  responsavel: string | null;
  uf: string | null;
  cidade: string | null;
  /** Every column as rendered, keyed by its Portuguese header. */
  columns: Record<string, string>;
}

const stripTags = (fragment: string): string =>
  fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/g, (m) => ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Result grids alternate row classes. Matching only `webgrid-row-style` returns
 * every other record — a silent half-truth, not an error, so it must be matched
 * against both.
 */
const GRID_ROW = /<tr class="webgrid(?:-row-style|-alternating-row)"[^>]*>([\s\S]*?)<\/tr>/g;

const parseProcessos = (html: string): Processo[] => {
  const headers = [...(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => stripTags(m[1] ?? ''));

  return [...html.matchAll(GRID_ROW)].flatMap((row) => {
    const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1] ?? ''));
    const id = Number((row[1] ?? '').match(/\/processos\/processos\/details\/(\d+)/)?.[1]);
    if (!id) return [];

    const columns: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) columns[h] = cells[i] ?? '';
    });

    // The "Processo" column renders the CNJ and the folder label in one cell.
    const processo = columns['Processo'] ?? '';
    return [{
      id,
      cnj: processo.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/)?.[0] ?? null,
      // Sub-matters render as "Proc - 0004500/001"; the suffix is part of the label.
      pasta: processo.match(/Proc\s*-\s*\d+(?:\/\d+)?/)?.[0] ?? null,
      status: columns['Status'] || null,
      tipo: columns['Tipo'] || null,
      acao: columns['Ação/Tipo'] || null,
      cliente: columns['Cliente'] || null,
      contrario: columns['Contrário principal'] || null,
      jurisdicao: columns['Jurisdição'] || null,
      titulo: columns['Título'] || null,
      responsavel: columns['Responsável principal'] || null,
      uf: columns['UF'] || null,
      cidade: columns['Cidade'] || null,
      columns,
    }];
  });
};

export interface Contato {
  id: number;
  nome: string | null;
  documento: string | null;
  columns: Record<string, string>;
}

export interface TimeEntryRecord {
  id: number;
  descricao: string | null;
  situacao: string | null;
  inicio: string | null;
  termino: string | null;
  duracaoOriginal: string | null;
  duracaoConsiderada: string | null;
  executante: string | null;
  columns: Record<string, string>;
}

const parseEntries = (html: string): TimeEntryRecord[] => {
  const headers = [...(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => stripTags(m[1] ?? ''));

  return [...html.matchAll(GRID_ROW)].flatMap((row) => {
    const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1] ?? ''));
    const id = Number((row[1] ?? '').match(/HorasTrabalhadas\/Details\/(\d+)/)?.[1]);
    if (!id) return [];

    const columns: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) columns[h] = cells[i] ?? '';
    });

    return [{
      id,
      descricao: columns['Descrição'] || null,
      situacao: columns['Situação'] || null,
      inicio: columns['Data/hora início'] || null,
      termino: columns['Data/hora término'] || null,
      duracaoOriginal: columns['Duração original'] || null,
      duracaoConsiderada: columns['Duração considerada'] || null,
      executante: columns['Executante'] || null,
      columns,
    }];
  });
};

/** Standalone matters live under Processos; dependent ones under Incidentes. */
export type MatterKind = 'processo' | 'incidente';

const MATTER_PATH: Record<MatterKind, string> = {
  processo: '/processos/Processos',
  incidente: '/processos/Incidentes',
};

/**
 * Legal One answers 405 both for "no action matched the bound int parameters" and
 * for "your user lacks permission". Same status, unrelated fixes — the only way to
 * tell them apart is the body.
 */
const permissionDenied = (html: string): boolean =>
  /n[\u00e3a]o possui permiss[\u00e3a]o para executar esta a[\u00e7c][\u00e3a]o/i.test(
    html.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))),
  );

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Reads a rendered form back into the name/value pairs a browser would submit.
 *
 * Matter forms cannot be templated the way the timesheet form can: field names
 * embed the record id (`..._o2017`) and nested rows carry per-record ids
 * (`Cliente.Id=8746`). Replaying a captured payload against a different record
 * would post another record's identifiers. Round-tripping the live form is the
 * only approach that generalises.
 */
const parseFormFields = (html: string): Array<[string, string]> => {
  const fields: Array<[string, string]> = [];

  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const name = tag.match(/\bname="([^"]*)"/)?.[1];
    if (!name) continue;
    const type = (tag.match(/\btype="([^"]*)"/)?.[1] ?? 'text').toLowerCase();
    if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
    // Browsers never submit disabled controls. Legal One disables whole sections
    // (e.g. the encerramento block while a matter is Ativo); posting them anyway
    // sends values the server then validates and rejects.
    if (/\bdisabled\b/.test(tag)) continue;
    // An unchecked box submits nothing; ASP.NET's hidden sibling carries the false.
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/.test(tag)) continue;
    fields.push([name, decodeEntities(tag.match(/\bvalue="([^"]*)"/)?.[1] ?? '')]);
  }

  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const attrs = m[1]!;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1];
    // `disabled` may appear anywhere in the tag, before or after `name`.
    if (!name || /\bdisabled\b/.test(attrs)) continue;
    // Per the HTML spec a single leading newline after <textarea> is not part of
    // the value. Submitting it verbatim turns an empty box into whitespace, which
    // Legal One reads as a filled field — an empty "motivo do encerramento" then
    // makes the closure date required and the whole save is rejected.
    fields.push([name, decodeEntities(m[2]!.replace(/^\r?\n/, ''))]);
  }

  /*
   * Lookup widgets (client, contrário, responsável, órgão, comarca…) have no
   * markup: jQuery builds their hidden inputs at runtime from a `.lookup({…})`
   * config (`.lookup` for flat pickers, `.lookupTree` for hierarchical ones such
   * as Escritório). Parsing only the served HTML would omit every one of them, and
   * posting that back would strip the matter's client and responsável — silent
   * destruction of master data. The config carries both the field names and the
   * current selection, so read them from there.
   */
  for (const marker of [...html.matchAll(/\.lookup(?:Tree)?\(\{/g)]) {
    const start = marker.index! + marker[0].length - 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < html.length; i++) {
      const ch = html[i]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end === -1) continue;

    let config: { inputHiddenName?: string; inputTextName?: string; value?: Array<{ HasValue?: boolean; Id?: number | string; Value?: string }> };
    try {
      config = JSON.parse(html.slice(start, end));
    } catch {
      continue; // a config we can't read is reported by readMatter's coverage check
    }

    /*
     * Flat `.lookup` widgets mark the chosen row with HasValue; `.lookupTree`
     * entries carry only Id/Value. Requiring HasValue silently emptied every
     * hierarchical field — Escritório responsável among them, which is required,
     * so the save was rejected with no message at all.
     */
    const selected =
      config.value?.find((v) => v?.HasValue) ??
      config.value?.find((v) => v?.Id != null) ??
      // Free-text lookups (the timesheet's Descrição) carry their content in
      // `Value` with HasValue:false and Id:null. Rejecting those read the field
      // as empty, so an update would have blanked the description.
      config.value?.find((v) => typeof v?.Value === 'string' && v.Value !== '');
    if (config.inputHiddenName) fields.push([config.inputHiddenName, selected?.Id != null ? String(selected.Id) : '']);
    if (config.inputTextName) fields.push([config.inputTextName, selected?.Value ?? '']);
  }

  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attrs = m[1]!;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1];
    if (!name || /\bdisabled\b/.test(attrs)) continue;
    const options = m[2] ?? '';
    const selected =
      options.match(/<option[^>]*\bselected\b[^>]*\bvalue="([^"]*)"/)?.[1] ??
      options.match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/)?.[1] ??
      '';
    fields.push([name, decodeEntities(selected)]);
  }

  /*
   * Some hidden companions are populated by JS at submit time, not rendered with a
   * value: `PercentualRateioHidden` is empty in the markup while its visible sibling
   * `PercentualRateio` reads "100,00", and the browser posts the hidden as "100".
   * Submitting the empty hidden loses the rateio on any entry with split billing.
   * Only this one pair behaves this way on the forms seen so far, but the rule is
   * safe: an empty hidden whose sibling has a value is one the browser would fill.
   */
  const byName = new Map(fields.map(([name, value]) => [name, value]));
  for (const field of fields) {
    const [name, value] = field;
    if (value !== '' || !name.endsWith('Hidden')) continue;
    const sibling = byName.get(name.slice(0, -'Hidden'.length));
    if (!sibling) continue;
    const numeric = Number(sibling.replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(numeric)) field[1] = String(numeric);
  }

  // The page header's global-search widget is not part of the entity form.
  return fields.filter(([name]) => !/^(search|searchselectall|global-search)/.test(name));
};

export interface ClientOptions {
  /** Full Cookie header from an authenticated browser session. */
  cookie: string;
  baseUrl?: string;
}

export class LegalOneTimesheet {
  constructor(private readonly options: ClientOptions) {}

  private get base(): string {
    const base = this.options.baseUrl ?? BASE;
    if (!base) {
      throw new Error(
        'no Legal One tenant configured — set LEGALONE_BASE_URL in .env (and run with --env-file=.env), ' +
          'or pass baseUrl to the constructor',
      );
    }
    return base.replace(/\/+$/, '');
  }

  private async post(url: string, body: string): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.options.cookie,
        Origin: this.base,
        Referer: url,
      },
      body,
    });

    const html = await response.text();

    if (!response.ok) {
      throw new Error(`Legal One returned ${response.status} ${response.statusText}`);
    }

    /*
     * A rejected form comes back 200 with the form re-rendered and the errors
     * inline — the same shape as success. Treating 200 as saved is how a silent
     * data-loss bug gets in, so detect the re-render explicitly.
     */
    if (/field-validation-error|validation-summary-errors/.test(html)) {
      const reason = html.match(/field-validation-error[^>]*>([^<]+)</)?.[1]?.trim();
      throw new Error(`Legal One rejected the entry: ${reason ?? 'validation failed'}`);
    }

    return html;
  }

  /** Creates a timesheet entry. Returns the new record id. */
  async create(entry: TimeEntry): Promise<number> {
    const html = await this.post(`${this.base}${PATH}/EditHoraTrabalhada`, buildBody(entry));
    const id = html.match(/HorasTrabalhadas\/Details\/(\d+)/)?.[1];
    if (!id) throw new Error('entry saved but no id found in the response');
    return Number(id);
  }

  /**
   * Patches an existing entry, preserving everything not named in `changes`.
   *
   * This round-trips the entry's own form rather than rebuilding from the create
   * template. The template is a frozen snapshot — `SituacaoId=0`, a fixed `ExecutanteId`,
   * `IsCobravel=false` — so replaying it would quietly revert an approved entry to
   * Pendente and reassign someone else's work to the template's executante.
   */
  async update(id: number, changes: Partial<TimeEntry>): Promise<void> {
    const path = `${PATH}/EditHoraTrabalhada/${id}`;
    const { pairs, html } = await this.readFormPairs(path);
    this.assertNoDroppedLookups(html, pairs, `entry ${id}`);

    const current = (name: string): string => pairs.find(([key]) => key === name)?.[1] ?? '';
    const vinculo = current('Vinculos.Index');
    const classificacao = pairs.find(([key]) => key.endsWith('.Classificacoes.Index'))?.[1] ?? '';
    const row = `Vinculos[${vinculo}].Classificacoes[${classificacao}]`;

    const date = changes.date ?? current('DtInicio');
    const startTime = changes.startTime ?? current('HrInicio');
    const endTime = changes.endTime ?? current('HrTermino');
    if (toSeconds(endTime) <= toSeconds(startTime)) throw new Error('endTime must be after startTime');
    if (changes.description !== undefined && changes.description.length > DESCRIPTION_MAX) {
      throw new Error(`description is ${changes.description.length} characters; the limit is ${DESCRIPTION_MAX}`);
    }

    const patch: Record<string, string> = {};
    if (changes.date !== undefined) { patch['DtInicio'] = date; patch['DtTermino'] = date; }
    if (changes.startTime !== undefined) patch['HrInicio'] = startTime;
    if (changes.endTime !== undefined) patch['HrTermino'] = endTime;

    if (changes.startTime !== undefined || changes.endTime !== undefined) {
      const duration = toDuration(toSeconds(endTime) - toSeconds(startTime));
      patch['Duracao'] = duration;
      patch[`${row}.DuracaoOriginalHoraTrabalhada`] = duration;
      // Keep considerada tracking the span unless the caller is setting it deliberately.
      if (changes.consideredDuration === undefined) patch[`${row}.DuracaoConsiderada`] = duration;
    }
    if (changes.consideredDuration !== undefined) patch[`${row}.DuracaoConsiderada`] = changes.consideredDuration;
    if (changes.description !== undefined) patch['DescricaoHT'] = changes.description;
    if (changes.observations !== undefined) patch['Observacoes'] = changes.observations;

    if (changes.link !== undefined) {
      const link = LinkSchema.parse(changes.link);
      const isProcesso = link.kind === 'processo';
      patch[`Vinculos[${vinculo}].TipoVinculo`] = isProcesso ? '1' : '0';
      patch[`Vinculos[${vinculo}].VinculoContatoText`] = isProcesso ? '' : link.text;
      patch[`Vinculos[${vinculo}].VinculoContatoId`] = isProcesso ? '' : String(link.id);
      patch[`Vinculos[${vinculo}].VinculoGridText`] = isProcesso ? link.text : '';
      patch[`Vinculos[${vinculo}].VinculoGridId`] = isProcesso ? String(link.id) : '';
    }

    const names = new Set(pairs.map(([name]) => name));
    const unknown = Object.keys(patch).filter((name) => !names.has(name));
    if (unknown.length > 0) throw new Error(`not fields on entry ${id}'s form: ${unknown.join(', ')}`);

    const body = pairs.map<[string, string]>(([name, value]) =>
      name in patch ? [name, patch[name]!] : [name, value],
    );
    body.unshift(['Id', String(id)]);
    body.push(['ButtonSave', '1']);

    await this.submitForm(path, body);

    /*
     * Collection keys are GUIDs regenerated on every render, so the field just
     * patched has a different name when read back. Compare with the GUIDs masked,
     * otherwise a correct save always looks like a failure.
     */
    const withoutGuids = (name: string) => name.replace(/\[[0-9a-f-]{36}\]/g, '[]');
    const after = await this.readFormPairs(path);
    const saved = new Map<string, string>();
    for (const [name, value] of after.pairs) {
      const key = withoutGuids(name);
      if (!saved.has(key)) saved.set(key, value);
    }
    const wrong = Object.entries(patch).filter(([name, value]) => saved.get(withoutGuids(name)) !== value);
    if (wrong.length > 0) {
      throw new Error(
        `update ${id} reported success but did not stick: ` +
          wrong.map(([n, v]) => `${n} expected "${v}", got "${saved.get(withoutGuids(n))}"`).join('; '),
      );
    }
  }

  /**
   * Reads a form as the ordered pairs a browser would submit, duplicates intact.
   *
   * Order and duplication matter. The form posts `Id` twice — the record id first,
   * then an empty one from a lookup widget — and ASP.NET binds the first. Collapsing
   * that to a map keeps the empty one, the action's `int Id` fails to bind, no action
   * matches POST, and IIS answers 405. Anything that submits a form must use this;
   * `readMatter` is for inspection only.
   */
  private async readFormPairs(path: string): Promise<{ pairs: Array<[string, string]>; html: string }> {
    const response = await fetch(`${this.base}${path}`, { headers: { Cookie: this.options.cookie } });
    if (!response.ok) throw new Error(`cannot read form ${path}: ${response.status}`);
    const html = await response.text();
    return { pairs: parseFormFields(html), html };
  }

  /** Throws if any lookup declared on the page was not recovered — see `updateMatter`. */
  private assertNoDroppedLookups(html: string, pairs: Array<[string, string]>, what: string): void {
    const names = new Set(pairs.map(([name]) => name));
    const declared = [...new Set([...html.matchAll(/"input(?:Hidden|Text)Name":"([^"]+)"/g)].map((m) => m[1]!))];
    const dropped = declared.filter((name) => !names.has(name));
    if (dropped.length > 0) {
      throw new Error(
        `refusing to submit ${what}: ${dropped.length} lookup field(s) could not be read and would be cleared — ` +
          `${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''}`,
      );
    }
  }

  private async submitForm(path: string, pairs: Array<[string, string]>): Promise<string> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.options.cookie,
        Origin: this.base,
        Referer: `${this.base}${path}`,
      },
      body: new URLSearchParams(pairs).toString(),
    });
    const html = await response.text();
    if (response.status === 405) {
      throw new Error(
        permissionDenied(html)
          ? `${path}: your Legal One user lacks permission for this action`
          : `${path} returned 405 — an int the action binds (Id on edit, EscritorioOrigemId on create) ` +
            `is missing or unparseable, so no POST action matched`,
      );
    }
    if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
    const message = html.match(/field-validation-error[^>]*>\s*([^<\s][^<]*)</)?.[1]?.trim();
    if (message) throw new Error(`Legal One rejected the submission: ${message}`);
    return html;
  }

  /**
   * Creates a matter and returns its record id.
   *
   * `values` are applied over the freshly-served create form, so the server's own
   * defaults — including the newly allocated `Pasta` — are preserved. Pass ids
   * resolved through `lookup`, not display names.
   */
  async createMatter(values: Record<string, string>, kind: MatterKind = 'processo'): Promise<number> {
    const path = `${MATTER_PATH[kind]}/Edit`;
    const { pairs, html } = await this.readFormPairs(path);
    this.assertNoDroppedLookups(html, pairs, `new ${kind}`);

    const names = new Set(pairs.map(([name]) => name));
    const unknown = Object.keys(values).filter((name) => !names.has(name));
    if (unknown.length > 0) throw new Error(`not fields on the ${kind} form: ${unknown.join(', ')}`);

    const applied = pairs.map<[string, string]>(([name, value]) =>
      name in values ? [name, values[name]!] : [name, value],
    );
    // Action selection binds this int; without it the POST 405s before reaching the app.
    if (!/^\d+$/.test(values['EscritorioOrigemId'] ?? '')) {
      throw new Error('createMatter requires a numeric EscritorioOrigemId — the POST action binds it');
    }
    applied.push(['ButtonSave', '1']);

    await this.submitForm(path, applied);

    /*
     * Read the matter back. Not every matter has a CNJ: the firm's STF records are
     * filed without one and carry their number in `OutroNumero` instead, and the
     * grid indexes that too. Requiring a CNJ here threw *after* a successful write,
     * so the matter existed but the caller got an error and no id. `Titulo` is not
     * indexed and cannot stand in as a verification key.
     */
    const cnj = values['NumeroCNJ'];
    const outro = values['OutroNumero'];
    const key = cnj || outro;
    if (!key) {
      throw new Error('created, but neither NumeroCNJ nor OutroNumero was supplied to verify it with');
    }
    // A CNJ search returns related matters too, so it is narrowed to exact matches;
    // OutroNumero has no equivalent field on the row, so uniqueness is the check.
    const hits = await this.searchProcessos(key);
    const found = cnj ? hits.filter((p) => p.cnj === cnj) : hits;
    if (found.length === 0) throw new Error(`submitted without error but no matter exists for ${key}`);
    if (found.length > 1) throw new Error(`${found.length} matters now match ${key} — possible duplicate`);
    return found[0]!.id;
  }

  /** Permanently deletes a matter. Legal One warns this cannot be undone. */
  async deleteMatter(id: number, kind: MatterKind = 'processo'): Promise<void> {
    const before = await fetch(`${this.base}${MATTER_PATH[kind]}/Edit/${id}`, {
      headers: { Cookie: this.options.cookie },
      redirect: 'manual',
    });
    await before.body?.cancel();
    if (before.status !== 200) throw new Error(`refusing to delete ${kind} ${id}: it does not exist`);

    /*
     * `isdeleteiManage` is bound by the action, so omitting it means no action
     * matches and the request 405s — the same trap as `Id` on edit and
     * `EscritorioOrigemId` on create. It reads as "not permitted"; it isn't.
     */
    const response = await fetch(
      `${this.base}${MATTER_PATH[kind]}/Delete/${id}?isdeleteiManage=False`,
      { headers: { Cookie: this.options.cookie }, redirect: 'follow' },
    );
    const outcome = await response.text();
    if (permissionDenied(outcome)) {
      throw new Error(
        `cannot delete ${kind} ${id}: your Legal One user lacks permission to delete matters ` +
          `(this is reported as HTTP 405). An administrator has to remove it.`,
      );
    }

    const after = await fetch(`${this.base}${MATTER_PATH[kind]}/Edit/${id}`, {
      headers: { Cookie: this.options.cookie },
      redirect: 'manual',
    });
    await after.body?.cancel();
    if (after.status === 200) throw new Error(`delete ${kind} ${id} did not take effect`);
  }

  /**
   * Resolves a lookup to its rows. `path` is the widget's `contentUrl`, e.g.
   * `/contatos/Contatos/LookupGridContato`; `term` filters server-side.
   *
   * Several lookups return near-identical labels — `term=Inquérito` yields four
   * matches, and three separate ids all render as "1º Grau" — so callers must
   * choose deliberately rather than taking the first row.
   */
  async lookup(path: string, term?: string, extra: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ pageSize: '25', ...extra, ...(term ? { term } : {}) });
    const response = await fetch(`${this.base}${path}${path.includes('?') ? '&' : '?'}${query}`, {
      headers: { Cookie: this.options.cookie, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!response.ok) throw new Error(`lookup ${path} failed: ${response.status}`);
    return ((await response.json()) as { Rows?: Array<Record<string, unknown>> }).Rows ?? [];
  }

  /**
   * Reads a matter's edit form as the field map a browser would submit.
   * Use it to inspect a record, or as the base for `updateMatter`.
   */
  async readMatter(id: number, kind: MatterKind = 'processo'): Promise<Record<string, string>> {
    const response = await fetch(`${this.base}${MATTER_PATH[kind]}/Edit/${id}`, {
      headers: { Cookie: this.options.cookie },
    });
    if (!response.ok) throw new Error(`cannot read ${kind} ${id}: ${response.status}`);
    /*
     * Keep the FIRST value for each name, which is what ASP.NET binds. The form
     * emits pairs — `Id=2018` then an empty `Id` from a lookup, `IsEncerrado=true`
     * then the hidden `false` — so last-wins reports the opposite of the truth.
     */
    const fields: Record<string, string> = {};
    for (const [name, value] of parseFormFields(await response.text())) {
      if (!(name in fields)) fields[name] = value;
    }
    return fields;
  }

  /**
   * Marks a matter closed. `Encerrado` is a flag (`IsEncerrado`), not one of the
   * Status options — Status stays Ativo/Suspenso/Baixado/Arquivado independently.
   */
  async closeMatter(
    id: number,
    options: { date?: string; reason?: string } = {},
    kind: MatterKind = 'processo',
  ): Promise<void> {
    const patch: Record<string, string> = { IsEncerrado: 'true' };
    if (options.date !== undefined) patch['DataEncerramento'] = options.date;
    if (options.reason !== undefined) patch['MotivoEncerramento'] = options.reason;
    await this.updateMatter(id, patch, kind);
  }

  /** Clears the closed flag, along with its date and reason. */
  async reopenMatter(id: number, kind: MatterKind = 'processo'): Promise<void> {
    await this.updateMatter(id, { IsEncerrado: 'false', DataEncerramento: '', MotivoEncerramento: '' }, kind);
  }

  /**
   * Patches fields on an existing matter, preserving everything else.
   *
   * This writes to firm master data rather than your own timesheet, so it is
   * deliberately narrow: only names already present in the form may be patched,
   * and a typo raises instead of silently adding a field the server ignores.
   * Every patched value is read back and confirmed after the save.
   */
  async updateMatter(id: number, patch: Record<string, string>, kind: MatterKind = 'processo'): Promise<void> {
    const path = `${MATTER_PATH[kind]}/Edit/${id}`;
    const { pairs, html } = await this.readFormPairs(path);
    this.assertNoDroppedLookups(html, pairs, `${kind} ${id}`);

    const names = new Set(pairs.map(([name]) => name));
    const unknown = Object.keys(patch).filter((name) => !names.has(name));
    if (unknown.length > 0) throw new Error(`not fields on this form: ${unknown.join(', ')}`);

    const applied = pairs.map<[string, string]>(([name, value]) =>
      name in patch ? [name, patch[name]!] : [name, value],
    );
    // The form also emits an empty `Id` from a lookup widget; put the real one first
    // so the action's int binds, then let the rest follow as the browser sends it.
    applied.unshift(['Id', String(id)]);
    applied.push(['ButtonSave', '1']);

    await this.submitForm(path, applied);

    const after = await this.readMatter(id, kind);
    const wrong = Object.entries(patch).filter(([name, value]) => after[name] !== value);
    if (wrong.length > 0) {
      throw new Error(`update reported success but did not stick: ${wrong.map(([n, v]) => `${n} expected "${v}", got "${after[n]}"`).join('; ')}`);
    }
  }

  /**
   * Moves an entry through the approval workflow.
   *
   * Entries are created Pendente. Advancing one is a billing act, not bookkeeping —
   * `Aprovada` and the financeiro states feed invoicing — so this is a separate,
   * explicit call rather than a field on `update`.
   */
  async setEntryStatus(id: number, status: EntryStatus): Promise<void> {
    const path = `${PATH}/EditHoraTrabalhada/${id}`;
    const { pairs, html } = await this.readFormPairs(path);
    this.assertNoDroppedLookups(html, pairs, `entry ${id}`);
    const body = pairs.map<[string, string]>(([name, value]) =>
      name === 'SituacaoId' ? [name, String(ENTRY_STATUS[status])] : [name, value],
    );
    body.unshift(['Id', String(id)]);
    body.push(['ButtonSave', '1']);
    await this.submitForm(path, body);

    const after = await this.readFormPairs(path);
    const saved = after.pairs.find(([name]) => name === 'SituacaoId')?.[1];
    if (saved !== String(ENTRY_STATUS[status])) {
      throw new Error(`status change on ${id} did not stick: wanted ${ENTRY_STATUS[status]}, got ${saved}`);
    }
  }

  /** True when the entry exists. `Details` answers 200 for a live record, 404 otherwise. */
  async exists(id: number): Promise<boolean> {
    const response = await fetch(`${this.base}${PATH}/Details/${id}`, {
      headers: { Cookie: this.options.cookie },
      redirect: 'manual',
    });
    await response.body?.cancel();
    return response.status === 200;
  }

  /**
   * Permanently deletes an entry. Legal One's own warning: "Esta operação não
   * poderá ser desfeita" — there is no undo and no trash.
   *
   * Deletion is a bare GET, so a mistyped id silently destroys a real record and
   * answers exactly like a success. This checks the entry exists first and
   * confirms it is gone afterwards, so a wrong id raises instead of doing nothing
   * quietly, and a failed delete cannot be mistaken for a completed one.
   */
  async delete(id: number): Promise<void> {
    if (!(await this.exists(id))) {
      throw new Error(`refusing to delete ${id}: no such entry (already deleted, or wrong id)`);
    }

    const response = await fetch(`${this.base}${PATH}/Delete/${id}`, {
      headers: { Cookie: this.options.cookie },
      redirect: 'follow',
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`delete ${id} failed: ${response.status}`);

    if (await this.exists(id)) throw new Error(`delete ${id} reported success but the entry is still there`);
  }

  /**
   * Lists entries in a date range. Returns raw HTML — the results grid is
   * server-rendered and there is no JSON endpoint behind it.
   */
  /**
   * All entries in a date range, across every page.
   *
   * The grid returns 18 rows per page. Reading only the first page silently
   * undercounts any range with more entries, which is dangerous for a duplicate
   * check: an entry on page 2 looks absent and gets written twice.
   */
  async listEntries(from: string, to: string): Promise<TimeEntryRecord[]> {
    const all: TimeEntryRecord[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = parseEntries(await this.searchRaw(from, to, page));
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  }

  async searchRaw(from: string, to: string, page = 1): Promise<string> {
    const query = new URLSearchParams({
      IsSearchExecutedByUser: 'true',
      ShowAdvancedFilters: 'True',
      SwitchToNewUXApplicationToggle: 'True',
      ShowBarCodeFilters: 'False',
      IsSomenteHorasTrabalhadasOrigemSemVinculo: 'false',
      IsHorasTrabalhadasHierarquia: 'false',
      TipoDtCadastro: '0',
      TipoDtInicio: '0',
      TipoDtTermino: '0',
      DtInicio: from,
      DtInicioFim: to,
      Page: String(page),
    });

    const response = await fetch(`${this.base}${PATH}/Search?${query}`, {
      headers: { Cookie: this.options.cookie },
    });

    if (!response.ok) throw new Error(`search failed: ${response.status}`);
    return response.text();
  }

  /**
   * Free-text search over matters. Matches CNJ numbers, folder labels, titles
   * and party names.
   *
   * Searching by the name you *call* a case is unreliable: on an ação penal the
   * Cliente field holds the individual defendant, so searching a company name does
   * not return its criminal matter — only the civil ones where the company is
   * itself a party. Prefer `resolveProcesso` with a CNJ when you have one, and
   * treat a name search as a discovery aid rather than a lookup.
   *
   * Returns the first page of results only.
   */
  async searchProcessos(term: string): Promise<Processo[]> {
    const all: Processo[] = [];
    for (let page = 1; page <= 50; page++) {
      const query = new URLSearchParams({
        IsSearchExecutedByUser: 'true',
        ShowAdvancedFilters: 'False',
        SwitchToNewUXApplicationToggle: 'True',
        ShowBarCodeFilters: 'False',
        Search: term,
        Page: String(page),
      });
      const response = await fetch(`${this.base}/processos/processos/Search?${query}`, {
        headers: { Cookie: this.options.cookie },
      });
      if (!response.ok) throw new Error(`processo search failed: ${response.status}`);
      const batch = parseProcessos(await response.text());
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  }

  /**
   * Free-text search over contacts (clients, opposing parties, courts).
   *
   * This answers "is the client registered at all?" — the question that decides
   * between creating a matter and escalating. Names drift: a timesheet's
   * "A. Ribeiro" may be registered as "ANTÔNIO RIBEIRO SOUZA", and a client may be
   * filed under a company rather than a person (or the reverse), so a miss here is
   * weaker evidence than a miss on a CNJ.
   */
  async searchContatos(term: string): Promise<Contato[]> {
    const query = new URLSearchParams({
      IsSearchExecutedByUser: 'true',
      ShowAdvancedFilters: 'False',
      SwitchToNewUXApplicationToggle: 'True',
      Search: term,
    });
    const response = await fetch(`${this.base}/contatos/contatos/Search?${query}`, {
      headers: { Cookie: this.options.cookie },
    });
    if (!response.ok) throw new Error(`contato search failed: ${response.status}`);
    const html = await response.text();

    const headers = [...(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '')
      .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => stripTags(m[1] ?? ''));

    return [...html.matchAll(GRID_ROW)].flatMap((row) => {
      const cells = [...(row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1] ?? ''));
      // The detail path segment varies by contact type (/contatos/empresas/...,
      // /contatos/pessoas/...), so match the type loosely and fall back to the
      // row checkbox, which always carries the id.
      const markup = row[1] ?? '';
      const id = Number(
        markup.match(/\/contatos\/[a-z]+\/details\/(\d+)/i)?.[1] ?? markup.match(/grid_check_(\d+)/)?.[1],
      );
      if (!id) return [];
      const columns: Record<string, string> = {};
      headers.forEach((h, i) => { if (h) columns[h] = cells[i] ?? ''; });
      return [{
        id,
        nome: columns['Nome / Razão social'] || columns['Nome/Razão social'] || columns['Nome'] || null,
        documento: columns['CPF/CNPJ'] || null,
        columns,
      }];
    });
  }

  /**
   * Creates a matter dependent on an existing one (an incidente), e.g. an ANPP
   * distributed by dependency on its parent action.
   *
   * The form is pre-filled from the parent before the values are applied, which is
   * how Legal One allocates the child folder (`Proc - 0004500/001`) and inherits
   * the parent's escritório and natureza. Passing values without that step would
   * create an unlinked matter that merely looks right.
   */
  async createIncidente(parentId: number, values: Record<string, string>): Promise<number> {
    const path = `${MATTER_PATH.incidente}/Edit`;
    const prefill = await fetch(`${this.base}${MATTER_PATH.incidente}/FillFormWithLinkedMatter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.options.cookie,
        Origin: this.base,
        Referer: `${this.base}${path}`,
      },
      body: new URLSearchParams({ vinculoToCopy: String(parentId), VinculoId: String(parentId) }).toString(),
    });
    if (!prefill.ok) throw new Error(`could not prefill from parent ${parentId}: ${prefill.status}`);
    const pairs = parseFormFields(await prefill.text());
    if (pairs.length === 0) throw new Error(`parent ${parentId} returned no form to build on`);

    const names = new Set(pairs.map(([name]) => name));
    const unknown = Object.keys(values).filter((name) => !names.has(name));
    if (unknown.length > 0) throw new Error(`not fields on the incidente form: ${unknown.join(', ')}`);

    const applied = pairs.map<[string, string]>(([name, value]) =>
      name in values ? [name, values[name]!] : [name, value],
    );
    applied.unshift(['VinculoId', String(parentId)]);
    applied.push(['ButtonSave', '1']);

    await this.submitForm(path, applied);

    const cnj = values['NumeroCNJ'];
    if (!cnj) throw new Error('created, but no NumeroCNJ was supplied to verify it with');
    const found = (await this.searchProcessos(cnj)).filter((p) => p.cnj === cnj);
    if (found.length !== 1) throw new Error(`expected exactly one matter for ${cnj}, found ${found.length}`);
    return found[0]!.id;
  }

  /**
   * Resolves exactly one matter by CNJ number. Throws when the number matches
   * nothing or more than one record — an ambiguous match must not silently pick
   * a matter to bill against.
   */
  async resolveProcesso(cnj: string): Promise<Processo> {
    const normalized = cnj.trim();
    const matches = (await this.searchProcessos(normalized)).filter((p) => p.cnj === normalized);

    if (matches.length === 0) throw new Error(`no matter found for CNJ ${normalized}`);
    if (matches.length > 1) {
      throw new Error(`CNJ ${normalized} matched ${matches.length} matters: ${matches.map((m) => m.pasta).join(', ')}`);
    }
    return matches[0]!;
  }
}
