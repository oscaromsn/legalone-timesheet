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
import { LegalOneTimesheet, SessionExpiredError, CONTATO_ESCRITORIO } from './src/client.ts';
import { planEntries } from './src/resolver.ts';

const TENANT = 'https://tenant.novajus.com.br';
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
    description: 'Acme — reunião', link: CONTATO_ESCRITORIO,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
