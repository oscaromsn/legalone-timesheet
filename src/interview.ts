import type { Contato, LegalOneTimesheet } from './client.ts';
import config from './aliases.json' with { type: 'json' };

/**
 * Turns a `matter-missing` resolution into the smallest set of questions a lawyer
 * actually has to answer.
 *
 * The matter form has 273 fields. Roughly 50 carry meaning, most of those are firm
 * constants or derivable from the CNJ, and only a handful are genuine judgement.
 * Asking all 50 would be unusable; guessing the judgement calls files hours against
 * the wrong client. So each field is sorted into derived / choose-one / must-ask.
 */

const defaults = config.defaults;

/**
 * The lookup endpoints the interview depends on, and the filters it sends them.
 *
 * Data rather than string literals so a diagnostic can hold them up against what a
 * tenant's own form declares. Every filter here is a magic integer from one install:
 * `tipoProcesso: '0'` pairs with a judicial matter, `idTipo: '0'` selects ação from
 * ação/recurso/incidente, `tipo: '0'` filters órgão type. All three return an empty
 * list rather than an error when the id space differs, which is exactly the kind of
 * nothing that reads as "no matches".
 */
export const MATTER_LOOKUPS = {
  posicao: {
    path: '/processos/Processos/LookupPosicaoEnvolvido',
    extra: { situacaoEnvolvido: '0', tipoProcesso: '0', pageSize: '100' } as Record<string, string>,
    fills: 'Cliente.PosicaoEnvolvidoId',
  },
  acao: {
    path: '/config/AcoesRecursosIncidentesProcesso/LookupTipoAcaoRecInc',
    extra: { idTipo: '0' } as Record<string, string>,
    fills: 'TipoAcaoId',
  },
  orgao: {
    path: '/config/orgaos/LookupOrgao',
    extra: { tipo: '0' } as Record<string, string>,
    fills: 'OrgaoId',
  },
} as const;

/** Justiça, from the CNJ's `J` digit. Fixed by the CNJ standard, not by this firm. */
const JUSTICA_BY_DIGIT: Record<string, string> = {
  '1': 'Supremo Tribunal Federal',
  '2': 'Conselho Nacional de Justiça',
  '3': 'Superior Tribunal de Justiça',
  '4': 'Justiça Federal',
  '5': 'Justiça do Trabalho',
  '6': 'Justiça Eleitoral',
  '7': 'Justiça Militar da União',
  '8': 'Justiça Estadual',
  '9': 'Justiça Militar Estadual',
};

export interface CnjParts {
  sequential: string;
  check: string;
  year: string;
  justiceDigit: string;
  justice: string | null;
  tribunal: string;
  unit: string;
}

export const parseCnj = (cnj: string): CnjParts | null => {
  const m = cnj.match(/^(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return {
    sequential: m[1]!, check: m[2]!, year: m[3]!,
    justiceDigit: m[4]!, justice: JUSTICA_BY_DIGIT[m[4]!] ?? null,
    tribunal: m[5]!, unit: m[6]!,
  };
};

/**
 * Builds a matter title from the firm's own convention.
 *
 * The convention lives in `aliases.json`, not here. It was a house format —
 * verified against ten matters of one practice, with one outlier that looked like a
 * typo — and a house format hardcoded in a shared client is just another firm's
 * convention imposed on everyone else. A firm with no fixed naming sets it to null
 * and gets no suggestion, which is better than getting someone else's.
 */
export const titleFor = (cnj: string, shortName: string, description: string): string | null => {
  const format = config.titleFormat;
  if (!format) return null;
  const parts = parseCnj(cnj);
  if (!parts) return null;
  const values: Record<string, string> = {
    seq2: parts.sequential.slice(-2),
    check: parts.check,
    year: parts.year,
    tribunal: parts.tribunal,
    unit: parts.unit,
    shortName,
    description,
    SHORTNAME: shortName.toUpperCase(),
    DESCRIPTION: description.toUpperCase(),
  };
  return format.replace(/\{(\w+)\}/g, (whole: string, key: string) => values[key] ?? whole);
};

export interface Choice {
  field: string;
  label: string;
  /** Empty when the lookup found nothing — then it is a must-ask, not a choice. */
  options: Array<{ id: string; value: string }>;
  note?: string;
}

export interface MatterProposal {
  cnj: string | null;
  contato: Contato;
  /** Safe to submit unchanged: firm constants and values fixed by the CNJ standard. */
  derived: Record<string, string>;
  /** Needs a pick. Never auto-selected, even when only one option comes back. */
  choices: Choice[];
  /** No candidate list exists; a human has to supply these. */
  mustAsk: string[];
  suggestedTitle: string | null;
}

/**
 * Builds the proposal. Performs lookups but writes nothing.
 */
export async function proposeMatter(
  client: LegalOneTimesheet,
  contato: Contato,
  cnj: string | null,
  hints: { acao?: string; orgao?: string; shortName?: string; titleDescription?: string } = {},
): Promise<MatterProposal> {
  const parts = cnj ? parseCnj(cnj) : null;

  const derived: Record<string, string> = {
    'Cliente.EnvolvidoId': String(contato.id),
    'Cliente.EnvolvidoText': contato.nome ?? '',
    'Responsavel.EnvolvidoId': defaults.responsavelId,
    'Responsavel.EnvolvidoText': defaults.responsavelText,
    'Responsavel.PosicaoEnvolvidoId': defaults.responsavelPosicaoId,
    'Responsavel.PosicaoEnvolvidoText': defaults.responsavelPosicaoText,
    NaturezaId: defaults.naturezaId,
    NaturezaText: defaults.naturezaText,
    /*
     * Two fields, not one value twice. A tenant can and does file matters whose
     * origem and responsável escritórios differ — measured here as origem at a
     * practice-area node and responsável at the firm root — and collapsing them
     * wrote the wrong escritório responsável on every matter this ever created.
     * Nothing surfaced it: createMatter verifies that one matter now matches the
     * number, never what is inside it.
     */
    EscritorioOrigemId: defaults.escritorioOrigemId,
    EscritorioOrigemText: defaults.escritorioOrigemText,
    EscritorioResponsavelId: defaults.escritorioResponsavelId,
    EscritorioResponsavelText: defaults.escritorioResponsavelText,
    LawsuitAmountType: '1',
    CostsType: '0',
  };
  if (cnj) derived['NumeroCNJ'] = cnj;

  const choices: Choice[] = [];
  const mustAsk: string[] = [];

  /*
   * Posição do cliente is always asked. It is the difference between Réu,
   * Investigado and Interessado on the same client, it changes what the record
   * means, and nothing in the timesheet line reliably implies it.
   */
  choices.push({
    field: 'Cliente.PosicaoEnvolvido',
    label: 'Posição do cliente principal',
    options: (await client.lookup(MATTER_LOOKUPS.posicao.path, undefined, MATTER_LOOKUPS.posicao.extra))
      .map((r) => ({ id: String(r['Id']), value: String(r['Value']) })),
  });

  const acaoOptions = await client.lookup(MATTER_LOOKUPS.acao.path, hints.acao, MATTER_LOOKUPS.acao.extra);
  choices.push({
    field: 'TipoAcao',
    label: 'Ação/Tipo',
    options: acaoOptions.map((r) => ({ id: String(r['Id']), value: String(r['Value']) })),
    // "Inquérito" alone returns four near-identical entries; picking the first files
    // the matter under the wrong action type with no visible symptom.
    note: acaoOptions.length > 1 ? `${acaoOptions.length} candidates — pick deliberately` : undefined,
  });

  const orgaoOptions = await client.lookup(MATTER_LOOKUPS.orgao.path, hints.orgao, MATTER_LOOKUPS.orgao.extra);
  choices.push({
    field: 'Orgao',
    label: 'Órgão',
    options: orgaoOptions.map((r) => ({ id: String(r['Id']), value: String(r['Value']) })),
    note: parts?.justice
      ? `CNJ says ${parts.justice} (tribunal ${parts.tribunal}, unidade ${parts.unit})`
      : undefined,
  });
  if (orgaoOptions.length === 0) mustAsk.push('Órgão (no candidates matched — search by another term)');

  /*
   * UF and cidade follow the órgão, not the sibling matters. Twice in this data a
   * sibling's recorded jurisdiction contradicted its own CNJ, so siblings are a
   * guide to conventions only, never to jurisdiction.
   */
  mustAsk.push('UF e cidade (derive from the órgão once chosen, not from sibling matters)');
  mustAsk.push('Contrário principal (blank is valid — several federal matters here have none)');

  const shortName = hints.shortName ?? (contato.nome ?? '').split(/\s+/).slice(0, 2).join(' ');
  const suggestedTitle =
    cnj && hints.titleDescription ? titleFor(cnj, shortName, hints.titleDescription) : null;

  return { cnj, contato, derived, choices, mustAsk, suggestedTitle };
}

/**
 * Submits a proposal once the open questions are answered.
 *
 * `answers` are merged over `derived`; anything still missing that the form
 * requires will be rejected by Legal One rather than silently defaulted.
 */
/**
 * Checks that a set of answers is complete enough to file a matter.
 *
 * `Choice.field` is a stem, not a form field: `TipoAcao` is answered by writing
 * both `TipoAcaoId` and `TipoAcaoText`. Legal One accepts an id without its label —
 * it stores the id and leaves the display half blank, producing a record that looks
 * filed and reads as half-written, with no error anywhere. Matters cannot be
 * deleted, so that is permanent.
 *
 * Returns the complaints, empty when the answers are usable.
 */
export const validateAnswers = (proposal: MatterProposal, answers: Record<string, string>): string[] => {
  const problems: string[] = [];

  for (const choice of proposal.choices) {
    const id = answers[`${choice.field}Id`];
    const text = answers[`${choice.field}Text`];
    if (!id && !text) problems.push(`${choice.label}: unanswered (needs ${choice.field}Id and ${choice.field}Text)`);
    else if (!id) problems.push(`${choice.label}: ${choice.field}Text was given without ${choice.field}Id`);
    else if (!text) problems.push(`${choice.label}: ${choice.field}Id was given without ${choice.field}Text`);
    else if (choice.options.length > 0 && !choice.options.some((o) => o.id === id)) {
      problems.push(`${choice.label}: "${id}" is not one of the ${choice.options.length} ids this tenant offered`);
    }
  }

  // The same pairing rule, applied to anything else the caller supplied.
  for (const name of Object.keys(answers)) {
    if (!name.endsWith('Id')) continue;
    const stem = name.slice(0, -2);
    if (proposal.choices.some((c) => c.field === stem)) continue; // already reported above
    if (answers[name] && answers[`${stem}Text`] === undefined) {
      problems.push(`${name} was given without ${stem}Text`);
    }
  }

  return problems;
};

/**
 * Files the matter. Refuses rather than filing something half-answered, because a
 * matter cannot be deleted and `createMatter`'s own verification only checks that
 * exactly one matter now matches the number — never what is inside it.
 *
 * `proposal.mustAsk` is free-text guidance for a person and cannot be checked
 * mechanically; it is repeated in the error so nothing is quietly dropped.
 */
export async function createFromProposal(
  client: LegalOneTimesheet,
  proposal: MatterProposal,
  answers: Record<string, string>,
): Promise<number> {
  const problems = validateAnswers(proposal, answers);
  if (problems.length > 0) {
    throw new Error(
      `refusing to file a matter from incomplete answers — matters cannot be deleted:\n  ` +
        problems.join('\n  ') +
        (proposal.mustAsk.length > 0 ? `\nAlso still open: ${proposal.mustAsk.join('; ')}` : ''),
    );
  }
  return client.createMatter({ ...proposal.derived, ...answers });
}
