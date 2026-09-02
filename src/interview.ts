import type { Contato, LegalOneTimesheet } from './client.ts';
import config from './aliases.json';

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
 * The house title format: last two digits of the sequential, the check digits,
 * then the client's short name and a description.
 *
 * Verified against ten existing matters. One outlier ([23-81] on 1081983-81) does
 * not fit and appears to be a typo in that record rather than a second convention.
 */
export const titleFor = (cnj: string, shortName: string, description: string): string | null => {
  const parts = parseCnj(cnj);
  if (!parts) return null;
  return `[${parts.sequential.slice(-2)}-${parts.check}] ${shortName.toUpperCase()} - ${description.toUpperCase()}`;
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
    EscritorioOrigemId: defaults.escritorioId,
    EscritorioOrigemText: defaults.escritorioText,
    EscritorioResponsavelId: defaults.escritorioId,
    EscritorioResponsavelText: defaults.escritorioText,
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
    options: (await client.lookup('/processos/Processos/LookupPosicaoEnvolvido', undefined, {
      situacaoEnvolvido: '0', tipoProcesso: '0', pageSize: '100',
    })).map((r) => ({ id: String(r['Id']), value: String(r['Value']) })),
  });

  const acaoOptions = await client.lookup(
    '/config/AcoesRecursosIncidentesProcesso/LookupTipoAcaoRecInc', hints.acao, { idTipo: '0' },
  );
  choices.push({
    field: 'TipoAcao',
    label: 'Ação/Tipo',
    options: acaoOptions.map((r) => ({ id: String(r['Id']), value: String(r['Value']) })),
    // "Inquérito" alone returns four near-identical entries; picking the first files
    // the matter under the wrong action type with no visible symptom.
    note: acaoOptions.length > 1 ? `${acaoOptions.length} candidates — pick deliberately` : undefined,
  });

  const orgaoOptions = await client.lookup('/config/orgaos/LookupOrgao', hints.orgao, { tipo: '0' });
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
export async function createFromProposal(
  client: LegalOneTimesheet,
  proposal: MatterProposal,
  answers: Record<string, string>,
): Promise<number> {
  return client.createMatter({ ...proposal.derived, ...answers });
}
