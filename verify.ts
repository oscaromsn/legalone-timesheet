/*
 * Regenerates every captured timesheet create and diffs it against the real
 * request, field by field.
 *
 * This is the gate before writing anything to Legal One: it proves the client
 * still reproduces a request Legal One is known to have accepted. That diff is
 * what located every parser bug in this codebase.
 *
 * Fixtures are your own captured traffic and are not distributed — they contain
 * real matters, contacts and rates. See "Maintenance" in the README for how to
 * capture one.
 */
/*
 * The gate runs against the configuration the fixtures were captured under.
 *
 * A captured request carries the template that produced it — the executante, the
 * área, the rate table. Diffing today's payload against yesterday's capture only
 * means something if both were built from the same configuration, so the baseline is
 * pinned beside the fixtures rather than read from whatever this machine happens to
 * be configured with.
 */
process.env['LEGALONE_CONFIG_DIR'] = new URL('fixtures/config/', import.meta.url).pathname;

import { readdirSync, readFileSync } from 'node:fs';
import { LegalOneTimesheet, type Link } from './src/client.ts';

const DIR = new URL('fixtures/', import.meta.url);

/**
 * Normalises a body so two of them can be compared: GUIDs become stable names, and
 * a name that appears more than once keeps every occurrence.
 *
 * The occurrence suffix is not decoration. This form posts duplicate keys on
 * purpose — `Maintain` and `IsToAutomaticallyCreateTask` each arrive as `true` then
 * `false`, a checkbox and its hidden companion — and ASP.NET binds the *first* one.
 * Collapsing them into a map keeps the last, so a generator that dropped the `true`
 * halves would produce a body that binds the opposite of the truth and still diff
 * clean. That is the same duplicate-key hazard that once blanked `Observacoes`
 * (see the parser notes in the README), and this file is the only thing standing
 * in front of it. Suffixing in document order also makes a *reordered* pair show
 * up, which matters for exactly the same binding reason.
 */
const norm = (p: URLSearchParams) => {
  const g = new Map<string, string>(); let n = 0;
  const sub = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (m) => { if (!g.has(m)) g.set(m, `G${n++}`); return g.get(m)!; });

  const seen = new Map<string, number>();
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of p) {
    const name = sub(key);
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    pairs.push([occurrence === 0 ? name : `${name}#${occurrence}`, sub(value)]);
  }
  return new Map(pairs.sort());
};

/** Drops the occurrence suffix, so field-name rules apply to every occurrence. */
const bare = (key: string) => key.replace(/#\d+$/, '');

const leaf = (key: string) => key.split('.').pop() ?? key;
const find = (p: URLSearchParams, name: string) =>
  [...p].find(([k]) => leaf(k) === name)?.[1] ?? '';

/**
 * Recovers the link the captured request was filed against.
 *
 * A contato link rides in `VinculoContato*`, a processo link in `VinculoGrid*` —
 * different fields, not two shapes of one field.
 */
const linkFrom = (p: URLSearchParams): Link | null => {
  const contato = find(p, 'VinculoContatoId');
  if (contato) return { kind: 'contato', id: Number(contato), text: find(p, 'VinculoContatoText') };
  const processo = find(p, 'VinculoGridId');
  if (processo) return { kind: 'processo', id: Number(processo), text: find(p, 'VinculoGridText') };
  return null;
};

let files: string[] = [];
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
} catch {
  // fixtures/ absent — handled below with the same message as an empty directory.
}

const cases = files.flatMap((file) => {
  const captured = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
  const body = captured.body;
  if (typeof body !== 'string') return [];
  const params = new URLSearchParams(body);
  // Matter creates live here too, and are not timesheet entries.
  if (!params.get('DtInicio') || !params.get('DescricaoHT')) return [];
  const link = linkFrom(params);
  // The captured path is checked too: a right body sent to a wrong endpoint saves
  // nothing, and the request this reproduces is the URL as much as the fields.
  const path = typeof captured.url === 'string' ? new URL(captured.url).pathname.replace(/\/+$/, '') : null;
  return link ? [{ file, params, link, path, method: captured.method ?? 'POST' }] : [];
});

if (cases.length === 0) {
  console.error(
    'No timesheet fixtures found in fixtures/.\n' +
    'Nothing was verified — capture a real create from DevTools (Network → the POST to\n' +
    '/TimeSheet/HorasTrabalhadas/EditHoraTrabalhada, which is what a create posts to) and save it as\n' +
    'fixtures/<name>.json with the raw form body under a "body" key.',
  );
  process.exit(1);
}

let failures = 0;
for (const { file, params: real, link, path, method } of cases) {
  let body = '';
  let sentPath = '';
  let sentMethod = '';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    body = String(init.body);
    sentPath = new URL(String(url)).pathname.replace(/\/+$/, '');
    sentMethod = String(init.method ?? 'GET').toUpperCase();
    return new Response('<a href="/TimeSheet/HorasTrabalhadas/Details/1">ok</a>', { status: 200 });
  }) as unknown as typeof fetch;

  // fetch is stubbed, so the tenant is never contacted — but `create` still builds
  // a URL from it. Passing one keeps this runnable on a fresh clone with no .env,
  // and under Node, which does not auto-load one the way Bun does.
  await new LegalOneTimesheet({ cookie: 'x', baseUrl: 'https://verify.invalid' }).create({
    date: real.get('DtInicio')!, startTime: real.get('HrInicio')!, endTime: real.get('HrTermino')!,
    description: real.get('DescricaoHT')!, link,
  });

  const A = norm(real), B = norm(new URLSearchParams(body));
  const keys = new Set([...A.keys(), ...B.keys()]);
  /*
   * Fields that vary between real successful creates and therefore carry no meaning:
   *   ButtonSave / LastFieldWithFocus  — UI focus state
   *   ValorHoraCobranca                — "N" vs "N,00000", same rate, server-render formatting
   *   TipoRecalculoValores             — "" vs "0"
   * Captured creates split across both variants and all of them saved; the variation
   * does not track link type. Verified in fixtures, not assumed.
   */
  const noise = (key: string) => {
    const k = bare(key);
    return k === 'ButtonSave' ||
      k.endsWith('LastFieldWithFocus') ||
      k.endsWith('ValorHoraCobranca') ||
      k.endsWith('TipoRecalculoValores');
  };
  const diffs = [...keys].filter((k) => A.get(k) !== B.get(k) && !noise(k));
  const wrongPath = path !== null && sentPath !== path;
  const wrongMethod = sentMethod !== String(method).toUpperCase();
  const bad = diffs.length > 0 || wrongPath || wrongMethod;
  console.log(`${bad ? 'FAIL' : 'ok  '}  ${file} (${link.kind}): ${A.size} vs ${B.size} fields, ${diffs.length} meaningful diffs`);
  if (wrongPath) { failures++; console.log(`        endpoint: real=${path} mine=${sentPath}`); }
  if (wrongMethod) { failures++; console.log(`        method: real=${String(method).toUpperCase()} mine=${sentMethod}`); }
  for (const k of diffs) { failures++; console.log(`        ${k}: real=${A.get(k)} mine=${B.get(k)}`); }
}
process.exit(failures ? 1 : 0);
