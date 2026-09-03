/*
 * Asserts the MCP surface behaves before an agent ever touches it.
 *
 * Offline: no network, no browser, no session. What is checked here is the contract
 * an agent relies on — that every tool is described well enough to be chosen
 * correctly, that a confirmation cannot be reused for different answers, and that
 * needing a person is a result rather than a failure.
 */
import { allTools } from './src/mcp/server.ts';
import { guard, page } from './src/mcp/context.ts';
import { LoginRequiredError } from './src/session.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

check('every tool has a unique name', new Set(allTools.map((t) => t.name)).size === allTools.length);
check('every tool declares a schema object', allTools.every((t) => typeof t.schema === 'object' && t.schema !== null));

{
  /*
   * Eighteen tools is a lot to choose between, and the mitigation for that is
   * description rather than structure. A one-line description is how an agent picks
   * the wrong one.
   */
  const thin = allTools.filter((t) => t.description.length < 120).map((t) => t.name);
  check('every description is substantial enough to choose by', thin.length === 0, thin.join(', '));
}

{
  const irreversible = allTools.find((t) => t.name === 'create_matter')!;
  check('the irreversible tool warns that it cannot be undone',
    /cannot be deleted|irreversible/i.test(irreversible.description));
}

{
  // A confirmation must bind to the answers it was issued for. Reusing one across a
  // changed answer is exactly how a person approves one matter and another is filed.
  const args = {
    contactId: 1, contactName: 'Example', hints: {},
    answers: { 'TipoAcaoId': '7', 'TipoAcaoText': 'Inquérito' },
    confirmationToken: 'obviously-not-the-right-token',
  };
  const result = await allTools.find((t) => t.name === 'create_matter')!.run(args);
  check('create_matter refuses a token that does not match the answers',
    result.ok === false && /token does not match/i.test(String((result as any).error)));
}

{
  // Same answers in a different order are the same answers.
  const a = { b: '2', a: '1' }, b = { a: '1', b: '2' };
  const tool = allTools.find((t) => t.name === 'create_matter')!;
  const r1 = await tool.run({ contactId: 1, contactName: 'x', hints: {}, answers: a, confirmationToken: 'x' });
  const r2 = await tool.run({ contactId: 1, contactName: 'x', hints: {}, answers: b, confirmationToken: 'x' });
  check('the token ignores key order', String((r1 as any).error) === String((r2 as any).error));
}

{
  const result = await guard(async () => { throw new LoginRequiredError('https://tenant.example/login', '/tmp/profile'); });
  check('needing a person is a result, not a failure',
    result.ok === false && 'loginUrl' in result && /sign in there/i.test(String((result as any).hint)),
    JSON.stringify(result).slice(0, 90));
}

{
  const result = await guard(async () => { throw new Error('aliases.json: defaults.escritorioOrigemId is "<escritorio-id>"'); });
  check('an unconfigured install points at setup instead of guessing',
    result.ok === false && /bun run setup/.test(String((result as any).hint)));
}

{
  const items = Array.from({ length: 60 }, (_, i) => i);
  const p = page(items, 25, 0);
  const last = page(items, 25, 50);
  check('paging caps the payload and reports the rest',
    p.items.length === 25 && p.total === 60 && p.more === true && last.items.length === 10 && last.more === false);
}

{
  const exporter = allTools.find((t) => t.name === 'export_timesheet')!;
  check('the export tool promises a file rather than rows',
    /file path/i.test(exporter.description) && /never the rows/i.test(exporter.description));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
