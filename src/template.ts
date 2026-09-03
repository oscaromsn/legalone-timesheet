/*
 * Builds a candidate create-template from a tenant's own form.
 *
 * `template.json` is the one frozen snapshot in this codebase: the timesheet create
 * form is identical every time, so a captured request can be replayed. That works
 * exactly as long as the snapshot came from *your* tenant — it carries a user id, an
 * área, a rate table and a rate. A firm that clones this repository inherits someone
 * else's, which is why the file is configuration rather than source.
 *
 * ## The limit, stated up front
 *
 * This cannot produce a complete template on its own, and the reason is worth
 * knowing. Measured against a real tenant, the served create form parses to 119
 * pairs and is missing two fields the working template carries —
 * `IsToAutomaticallyCreateTask` and `IsRatearHoraTrabalhada`. Neither appears as an
 * `<input>` anywhere in the html: they are written by JavaScript at submit time, the
 * same way `PercentualRateioHidden` is. No amount of parsing finds a field the
 * server never rendered.
 *
 * So this reports rather than overwrites. It gives a new tenant its own 119 fields,
 * names the handful that only a captured request can settle, and diffs the whole
 * thing against whatever template is installed. Adopting it stays a decision, and
 * `verify.ts` remains the gate that grades the result.
 */
import type { LegalOneTimesheet } from './client.ts';

const CREATE_FORM = '/TimeSheet/HorasTrabalhadas/EditHoraTrabalhada';
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The three collection rows a create body binds, and the index field that names each. */
const ROWS = [
  { placeholder: 'VINC', indexField: 'Vinculos.Index' },
  { placeholder: 'EXEC', indexField: 'Executantes.Index' },
  { placeholder: 'CLAS', indexField: 'Classificacoes.Index' },
] as const;

export interface TemplateDiff {
  /** In the installed template, absent from the generated one. */
  missing: string[];
  /** Produced by the form, absent from the installed template. */
  extra: string[];
  /** Present in both under the same name, with a different value. */
  changed: Array<{ key: string; installed: string; generated: string }>;
}

export interface TemplateCandidate {
  /** Ordered pairs, GUIDs replaced by the {VINC}/{EXEC}/{CLAS} placeholders. */
  pairs: Array<[string, string]>;
  /** Against the currently installed src/template.json. */
  diff: TemplateDiff;
  warnings: string[];
}

/**
 * Replaces this render's GUIDs with the placeholders `bindTemplate` re-binds.
 *
 * Keys are not enough: `Classificacoes[<guid>].LastFieldWithFocus` carries the GUIDs
 * in its *value* too, so a key-only substitution leaves a dead reference to a row
 * that no longer exists under that name.
 */
function placeholderise(pairs: Array<[string, string]>): { pairs: Array<[string, string]>; warnings: string[] } {
  const warnings: string[] = [];
  const map = new Map<string, string>();

  for (const { placeholder, indexField } of ROWS) {
    const hits = pairs.filter(([key]) => key.endsWith(indexField)).map(([, value]) => value).filter(Boolean);
    const distinct = [...new Set(hits)];
    if (distinct.length === 0) {
      warnings.push(`no ${indexField} on the form, so the ${placeholder} row could not be identified.`);
      continue;
    }
    if (distinct.length > 1) {
      /*
       * `bindTemplate` and `rowFields` both assume exactly one row of each kind.
       * More than one means the form is shaped differently — split billing renders
       * several Classificações — and the template model no longer describes it.
       */
      warnings.push(
        `${indexField} appears ${distinct.length} times; the template model assumes one ${placeholder} row. ` +
          'This tenant\'s form is shaped differently and needs a look before the result is trusted.',
      );
    }
    map.set(distinct[0]!, placeholder);
  }

  const seen = new Set([...pairs.flatMap(([k, v]) => [...`${k} ${v}`.matchAll(GUID)].map((m) => m[0]))]);
  const unmapped = [...seen].filter((g) => !map.has(g));
  if (unmapped.length > 0) {
    warnings.push(`${unmapped.length} GUID(s) on the form belong to no known row and were left as they are.`);
  }

  const swap = (s: string) => s.replace(GUID, (g) => (map.has(g) ? `{${map.get(g)}}` : g));
  return { pairs: pairs.map(([k, v]) => [swap(k), swap(v)] as [string, string]), warnings };
}

const diffAgainst = (
  generated: Array<[string, string]>,
  installed: Array<[string, string]>,
): TemplateDiff => {
  // Duplicate names are load-bearing here, so compare occurrence by occurrence.
  const index = (pairs: Array<[string, string]>) => {
    const seen = new Map<string, number>();
    return new Map(pairs.map(([k, v]) => {
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return [n === 0 ? k : `${k}#${n}`, v] as [string, string];
    }));
  };
  const g = index(generated), i = index(installed);
  return {
    missing: [...i.keys()].filter((k) => !g.has(k)),
    extra: [...g.keys()].filter((k) => !i.has(k)),
    changed: [...i].flatMap(([k, v]) =>
      g.has(k) && g.get(k) !== v ? [{ key: k, installed: v, generated: g.get(k)! }] : [],
    ),
  };
};

/**
 * Reads the tenant's create form and proposes a template. Writes nothing.
 *
 * `installed` is the template currently in use, for the diff — pass the parsed
 * `src/template.json`.
 */
export async function generateTemplate(
  client: LegalOneTimesheet,
  installed: Array<[string, string]>,
): Promise<TemplateCandidate> {
  const { pairs: raw } = await client.readFormPairs(CREATE_FORM);
  const { pairs, warnings } = placeholderise(raw);
  const diff = diffAgainst(pairs, installed);

  if (diff.missing.length > 0) {
    warnings.push(
      `${diff.missing.length} field(s) the installed template carries are not on the served form: ` +
        `${diff.missing.join(', ')}. Fields JavaScript writes at submit time cannot be parsed out of html — ` +
        'settle these from a captured request rather than from this candidate.',
    );
  }

  /*
   * A blank create form renders the rate block empty: área, tabela de valores and
   * the rateio are filled by the recalculation that fires once a link is chosen, so
   * a template generated from a form nobody has touched carries none of them.
   *
   * These are exactly the values `discover()` reads off the firm's existing entries,
   * where they arrive already settled and agreed across records. The two halves are
   * meant to be composed: the form gives the shape, the history gives the values.
   */
  const blanked = diff.changed.filter((c) => c.generated === '' && c.installed !== '').map((c) => c.key);
  if (blanked.length > 0) {
    warnings.push(
      `${blanked.length} field(s) came back empty because a blank form has no rate block yet: ` +
        `${blanked.map((k) => k.split('.').pop()).join(', ')}. Take these from discovery, which reads them ` +
        'off entries the firm has already booked.',
    );
  }
  return { pairs, diff, warnings };
}

/** Renders a candidate for a person to read before anything is adopted. */
export const format = (c: TemplateCandidate): string => {
  const lines = [
    `generated ${c.pairs.length} pairs from the tenant's own create form`,
    `  ${c.diff.missing.length} missing, ${c.diff.extra.length} extra, ${c.diff.changed.length} changed vs the installed template`,
  ];
  if (c.diff.changed.length > 0) {
    lines.push('', 'changed:');
    for (const { key, installed, generated } of c.diff.changed.slice(0, 20)) {
      lines.push(`  ${key}`);
      lines.push(`      installed: ${installed.slice(0, 70)}`);
      lines.push(`      generated: ${generated.slice(0, 70)}`);
    }
  }
  if (c.diff.extra.length > 0) lines.push('', `extra: ${c.diff.extra.join(', ').slice(0, 400)}`);
  if (c.warnings.length > 0) {
    lines.push('', 'before adopting:');
    for (const w of c.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
};
