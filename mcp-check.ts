/*
 * Asserts the MCP surface behaves before an agent ever touches it.
 *
 * Offline: no network, no browser, no session. What is checked here is the contract
 * an agent relies on — that every tool is described well enough to be chosen
 * correctly, that a confirmation cannot be reused for different answers, and that
 * needing a person is a result rather than a failure.
 */
import { allTools, INSTRUCTIONS } from './src/mcp/server.ts';
import { prompts } from './src/mcp/prompts.ts';
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

{
  /*
   * The surfaces have to agree, and nothing checked that they did.
   *
   * SKILL.md told an agent to call `planEntries(client, entries)` while the server
   * instructions told it to run `plan_entries` — one of those is a library call no
   * MCP client can make, and a model holding both will sometimes hand a lawyer a
   * TypeScript snippet. Every surface names tools, so every name they use has to be
   * a tool that exists, and none of them may speak in function calls.
   */
  const names = new Set(allTools.map((t) => t.name));
  const surfaces: Array<{ where: string; text: string }> = [
    { where: 'instructions', text: INSTRUCTIONS },
    ...allTools.map((t) => ({ where: `tool ${t.name}`, text: t.description })),
    ...prompts.map((p) => ({ where: `prompt ${p.name}`, text: `${p.description}\n${p.body({})}` })),
  ];

  const unknownNames: string[] = [];
  const libraryCalls: string[] = [];
  for (const { where, text } of surfaces) {
    for (const token of text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
      if (!names.has(token)) unknownNames.push(`${where}: ${token}`);
    }
    for (const call of text.match(/\b[a-zA-Z][a-zA-Z0-9]*\([a-zA-Z]/g) ?? []) {
      libraryCalls.push(`${where}: ${call}`);
    }
  }
  check('every snake_case name a surface uses is a tool that exists',
    unknownNames.length === 0, unknownNames.join(', '));
  check('no surface tells an agent to call a library function',
    libraryCalls.length === 0, libraryCalls.join(', '));

  check('the three procedures a person starts are registered',
    prompts.length === 3 && prompts.every((p) => p.title.length > 0 && p.description.length > 0));
  check('every prompt body orders the tools it depends on',
    prompts.every((p) => /session_status|authenticate/.test(p.body({}))),
    prompts.filter((p) => !/session_status|authenticate/.test(p.body({}))).map((p) => p.name).join(', '));

  const setup = prompts.find((p) => p.name === 'configurar')!;
  check('the setup procedure explains the browser window before authenticating',
    /before authenticate/i.test(setup.body({})) && /only on this computer|kept only/i.test(setup.body({})));
  check('the setup procedure refuses block approval of aliases',
    /ONE AT A TIME/.test(setup.body({})) && /never revive one the proposal refused/i.test(setup.body({})));
}

{
  const apply = allTools.find((t) => t.name === 'apply_config')!;
  check('applying a configuration warns that it is unproved',
    /provisional/i.test(apply.description) && /setup --write/.test(apply.description));
  const log = allTools.find((t) => t.name === 'log_entries')!;
  check('booking hours asks for the configVersion the plan was made under',
    /configVersion/.test(log.description));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
