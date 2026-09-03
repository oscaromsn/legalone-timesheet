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
import { readdirSync, readFileSync } from 'node:fs';
import { LegalOneTimesheet, type Link } from './src/client.ts';

const DIR = new URL('fixtures/', import.meta.url);

/** Replaces the per-request GUIDs with stable names so two bodies can be compared. */
const norm = (p: URLSearchParams) => {
  const g = new Map<string, string>(); let n = 0;
  const sub = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (m) => { if (!g.has(m)) g.set(m, `G${n++}`); return g.get(m)!; });
  return new Map([...p].map(([k, v]) => [sub(k), sub(v)]).sort());
};

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
  const body = JSON.parse(readFileSync(new URL(file, DIR), 'utf8')).body;
  if (typeof body !== 'string') return [];
  const params = new URLSearchParams(body);
  // Matter creates live here too, and are not timesheet entries.
  if (!params.get('DtInicio') || !params.get('DescricaoHT')) return [];
  const link = linkFrom(params);
  return link ? [{ file, params, link }] : [];
});

if (cases.length === 0) {
  console.error(
    'No timesheet fixtures found in fixtures/.\n' +
    'Nothing was verified — capture a real create from DevTools (Network → the POST to\n' +
    '/TimeSheet/HorasTrabalhadas/CreateHoraTrabalhada) and save it as\n' +
    'fixtures/<name>.json with the raw form body under a "body" key.',
  );
  process.exit(1);
}

let failures = 0;
for (const { file, params: real, link } of cases) {
  let body = '';
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    body = String(init.body);
    return new Response('<a href="/TimeSheet/HorasTrabalhadas/Details/1">ok</a>', { status: 200 });
  }) as typeof fetch;

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
  const noise = (k: string) =>
    k === 'ButtonSave' ||
    k.endsWith('LastFieldWithFocus') ||
    k.endsWith('ValorHoraCobranca') ||
    k.endsWith('TipoRecalculoValores');
  const diffs = [...keys].filter((k) => A.get(k) !== B.get(k) && !noise(k));
  console.log(`${diffs.length ? 'FAIL' : 'ok  '}  ${file} (${link.kind}): ${A.size} vs ${B.size} fields, ${diffs.length} meaningful diffs`);
  for (const k of diffs) { failures++; console.log(`        ${k}: real=${A.get(k)} mine=${B.get(k)}`); }
}
process.exit(failures ? 1 : 0);
