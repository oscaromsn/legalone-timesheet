/*
 * Asserts that an expired session is refused, never interpreted.
 *
 * Forms auth answers 302 to the login form, and `redirect: 'follow'` turns that
 * into a 200 whose body is the login page. Before this was detected, the parsers
 * read that page as the one they asked for and the client answered confidently
 * with nonsense: the searches returned [], so `planEntries` reported a registered
 * client as "not registered — administrative has to create it first"; `exists`
 * returned false, so `delete` refused a live entry as missing; `create` threw
 * "entry saved but no id found", claiming a save that never happened.
 *
 * Unlike verify.ts this needs no fixtures — it stubs fetch — so it runs anywhere.
 * Add a case here whenever a new fetch site is added to the client.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * A synthetic configuration, so this gate stays runnable on a fresh clone.
 *
 * `planEntries` now refuses to resolve against an unconfigured installation — an
 * absent alias table used to produce confident wrong answers rather than errors. That
 * guard is correct and it means this file, which tests expiry detection and has
 * nothing to say about how a firm is configured, has to bring a configuration of its
 * own. Written to a temp directory rather than committed: a real one names clients.
 */
{
  const dir = mkdtempSync(join(tmpdir(), 'legalone-gate-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({
    aliases: {},
    internal: { prefixes: ['Escritório'] },
    defaults: {
      escritorioOrigemId: '1', escritorioOrigemText: 'Example firm',
      escritorioResponsavelId: '1', escritorioResponsavelText: 'Example firm',
      responsavelId: '2', responsavelText: 'Example lawyer',
      responsavelPosicaoId: '3', responsavelPosicaoText: 'Responsável',
      naturezaId: '4', naturezaText: 'Example natureza',
      contatoEscritorioId: '5', contatoEscritorioText: 'Example firm',
    },
    titleFormat: null,
  }));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  process.env['LEGALONE_CONFIG_DIR'] = dir;
}

import { LegalOneTimesheet, SessionExpiredError, type Link } from './src/client.ts';
import { withRenewal } from './src/auth.ts';
import { portTimeout } from './src/session.ts';
import { planEntries } from './src/resolver.ts';

const TENANT = 'https://tenant.novajus.com.br';

/*
 * A made-up link, deliberately not the firm contact from `aliases.json`.
 *
 * This file tests expiry detection, which has nothing to do with how a firm is
 * configured — and coupling the two made a fresh clone fail its own documented
 * first run: the example config's `<firm-contact-id>` placeholder parses to NaN,
 * so three cases died on a Zod complaint about a link and reported themselves as
 * detection failures. The gate must pass before setup has ever run.
 */
const LINK: Link = { kind: 'contato', id: 1, text: 'Example firm' };
const LOGIN_HTML = `<!doctype html><html><body><form action="/Account/Login" method="post">
  <input name="UserName" type="text" /><input name="Password" type="password" />
  <input type="submit" value="Entrar" /></form></body></html>`;

const SIGNON_HTML = `<!doctype html><html><head><title>Legal One Firm Signon</title></head><body>
  <p>Atualizar as configura&#231;&#245;es do navegador para continuar</p>
  <p>Ativar meus cookies &mdash; Fail</p><p>Ativar o JavaScript &mdash; Fail</p></body></html>`;

/** The three shapes an expired session actually arrives in. */
const shapes = {
  /** forms auth redirect, followed: 200 whose final URL carries ReturnUrl */
  followed: () => {
    const r = new Response(LOGIN_HTML, { status: 200 });
    Object.defineProperty(r, 'url', { value: `${TENANT}/Account/Login?ReturnUrl=%2fTimeSheet` });
    return r;
  },
  /** redirect: 'manual' — the 302 itself, Location pointing at the login */
  manual: () => new Response('', { status: 302, headers: { location: `${TENANT}/Account/Login?ReturnUrl=%2fx` } }),
  /** login page served 200 at the requested URL — only the body gives it away */
  bodyOnly: () => new Response(LOGIN_HTML, { status: 200 }),
  /*
   * What a federated tenant actually does, measured against a real expired
   * session: the IdP bounce is followed to `/`, so the final URL keeps no
   * ReturnUrl, and with JS disabled the page is a Signon shell asking the browser
   * to enable cookies — it never renders a password input. Title only.
   */
  federated: () => {
    const r = new Response(SIGNON_HTML, { status: 200 });
    Object.defineProperty(r, 'url', { value: `${TENANT}/` });
    return r;
  },
};

/** AJAX endpoints do not redirect: forms auth answers 403 with IIS's own message. */
const ajax403 = () => new Response('You do not have permission to view this directory or page.', {
  status: 403, headers: { 'content-type': 'text/html' },
});

let pass = 0, fail = 0;
async function expectExpired(what: string, shape: keyof typeof shapes, run: (c: LegalOneTimesheet) => Promise<unknown>) {
  globalThis.fetch = (async () => shapes[shape]()) as unknown as typeof fetch;
  const client = new LegalOneTimesheet({ cookie: 'stale', baseUrl: TENANT });
  try {
    const result = await run(client);
    fail++;
    console.log(`FAIL  ${what} [${shape}] returned ${JSON.stringify(result)?.slice(0, 60)} instead of throwing`);
  } catch (e) {
    if (e instanceof SessionExpiredError) { pass++; console.log(`ok    ${what} [${shape}]`); }
    else { fail++; console.log(`FAIL  ${what} [${shape}] threw ${(e as Error).name}: ${(e as Error).message.slice(0, 80)}`); }
  }
}

for (const shape of ['followed', 'bodyOnly', 'federated'] as const) {
  await expectExpired('searchContatos', shape, (c) => c.searchContatos('Acme'));
  await expectExpired('searchProcessos', shape, (c) => c.searchProcessos('Acme'));
  await expectExpired('listEntries', shape, (c) => c.listEntries('01/09/2026', '30/09/2026'));
  await expectExpired('lookup', shape, (c) => c.lookup('/contatos/Contatos/LookupGridContato', 'Acme'));
  await expectExpired('readMatter', shape, (c) => c.readMatter(1));
  await expectExpired('create', shape, (c) => c.create({
    date: '01/09/2026', startTime: '09:00:00', endTime: '10:00:00',
    description: 'Acme — reunião', link: LINK,
  }));
  await expectExpired('update', shape, (c) => c.update(1, { description: 'x' }));
  await expectExpired('createMatter', shape, (c) => c.createMatter({ EscritorioOrigemId: '9' }));
  await expectExpired('planEntries', shape, (c) => planEntries(c, [{
    date: '01/09/2026', startTime: '09:00:00', endTime: '10:00:00', description: 'Acme — reunião',
  }]));
}
// lookup is the only AJAX caller, and the only one that sees the 403 instead.
globalThis.fetch = (async () => ajax403()) as unknown as typeof fetch;
try {
  await new LegalOneTimesheet({ cookie: 'stale', baseUrl: TENANT })
    .lookup('/contatos/Contatos/LookupGridContato', 'Acme');
  fail++; console.log('FAIL  lookup [ajax403] returned instead of throwing');
} catch (e) {
  if (e instanceof SessionExpiredError) { pass++; console.log('ok    lookup [ajax403]'); }
  else { fail++; console.log(`FAIL  lookup [ajax403] threw ${(e as Error).name}`); }
}

// exists/delete keep the 302, so they are the manual-redirect cases.
await expectExpired('exists', 'manual', (c) => c.exists(1));
await expectExpired('delete', 'manual', (c) => c.delete(1));
await expectExpired('deleteMatter', 'manual', (c) => c.deleteMatter(1));

/*
 * Renewal policy. Pure logic — no browser, no network, no client: what is being
 * checked is which recovery a caller gets, and how many times each side runs.
 */
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

{
  // An operation that proves its own result: retry after one renewal.
  let runs = 0, renewals = 0;
  const value = await withRenewal(
    async () => { runs++; if (runs === 1) throw new SessionExpiredError('read'); return 'ok'; },
    'retry',
    async () => { renewals++; },
  );
  check('renewal: idempotent op retries once', runs === 2 && renewals === 1 && value === 'ok', `runs=${runs} renewals=${renewals}`);
}

{
  // The write landed before the expiry: adopt it, never run again.
  let runs = 0;
  const value = await withRenewal(
    async () => { runs++; throw new SessionExpiredError('create'); },
    async () => ({ landed: true, value: 42 }),
    async () => {},
  );
  check('renewal: guarded op adopts work that landed', runs === 1 && value === 42, `runs=${runs}`);
}

{
  // Absence proved, so one more attempt cannot duplicate anything.
  let runs = 0;
  const value = await withRenewal(
    async () => { runs++; if (runs === 1) throw new SessionExpiredError('create'); return 7; },
    async () => ({ landed: false }),
    async () => {},
  );
  check('renewal: guarded op re-runs only once absence is proved', runs === 2 && value === 7, `runs=${runs}`);
}

{
  // A second expiry is not a cookie problem. Propagate rather than loop.
  let runs = 0, renewals = 0;
  let raised: unknown = null;
  try {
    await withRenewal(
      async () => { runs++; throw new SessionExpiredError('read'); },
      'retry',
      async () => { renewals++; },
    );
  } catch (e) { raised = e; }
  check('renewal: does not loop when renewing did not help',
    runs === 2 && renewals === 1 && raised instanceof SessionExpiredError, `runs=${runs} renewals=${renewals}`);
}

{
  // Anything that is not an expiry is none of this policy's business.
  let renewals = 0;
  let message = '';
  try {
    await withRenewal(async () => { throw new Error('rejected by Legal One'); }, 'retry', async () => { renewals++; });
  } catch (e) { message = (e as Error).message; }
  check('renewal: leaves other failures alone', renewals === 0 && message === 'rejected by Legal One');
}

{
  /*
   * A browser that never opened a port has two causes and one symptom, and the
   * message has to separate them: a sandbox denying the profile write was, in
   * testing, reported as "did not open a debugging port" and read as a bug in this
   * client for an hour. Whichever branch is taken, the message must name a profile
   * directory — that is the thing the reader acts on.
   */
  const confined = portTimeout('/somewhere/browser', 30_000, false);
  const collision = portTimeout('/somewhere/browser', 30_000, true);
  check('port timeout: an empty profile is reported as confinement, not slowness',
    /sandbox|policy/i.test(confined) && !/another instance/i.test(confined), confined);
  check('port timeout: a written profile is reported as a collision',
    /another instance/i.test(collision) && !/sandbox/i.test(collision), collision);
  check('port timeout: both name the directory to act on',
    confined.includes('/somewhere/browser') && collision.includes('/somewhere/browser'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
