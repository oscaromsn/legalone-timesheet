/*
 * Asserts that an unconfigured installation says so, and that writing one is safe.
 *
 * Configuration moved out of the source tree and became runtime state, which bought
 * the thing that made a conversational setup possible — a written configuration
 * applies without restarting — and introduced two ways to fail quietly that a static
 * import could not have. A half-written file is unparseable to the next reader, and a
 * configuration that is merely *absent* used to be answered with somebody else's
 * example: three fictional aliases that rewrite a real client name into a company
 * that does not exist, after which the search reports it unregistered.
 *
 * It also covers the alias refusals, which are configuration in the sense that
 * matters: an alias applies to every future line whose head matches, so a wrong one
 * books hours against the wrong client for as long as nobody notices.
 *
 * Offline, no tenant, no fixtures. Every case works on a temp directory.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const scratch = (): string => mkdtempSync(join(tmpdir(), 'legalone-config-'));

const FULL_DEFAULTS = {
  escritorioOrigemId: '1', escritorioOrigemText: 'Example firm',
  escritorioResponsavelId: '1', escritorioResponsavelText: 'Example firm',
  responsavelId: '2', responsavelText: 'Example lawyer',
  responsavelPosicaoId: '3', responsavelPosicaoText: 'Responsável',
  naturezaId: '4', naturezaText: 'Example natureza',
  contatoEscritorioId: '5', contatoEscritorioText: 'Example firm',
};
const full = (over: Record<string, string> = {}) => ({
  aliases: {}, internal: { prefixes: ['Escritório'] },
  defaults: { ...FULL_DEFAULTS, ...over }, titleFormat: null,
});

/** Loads the module against a directory, fresh each time — the cache is per process. */
const at = async (dir: string) => {
  process.env['LEGALONE_CONFIG_DIR'] = dir;
  const mod = await import(`./src/config.ts?${Math.random()}`);
  mod.reloadConfig();
  return mod as typeof import('./src/config.ts');
};

{
  const dir = scratch();
  const c = await at(dir);
  const state = c.configState();
  check('an installation with no configuration reports itself unconfigured', !state.configured);
  check('and names the path a person would have to look at',
    state.reasons.some((r) => r.includes(dir)), state.reasons.join(' | '));
  check('an absent configuration carries no aliases at all',
    Object.keys(c.firmConfig().aliases).length === 0,
    `got ${JSON.stringify(c.firmConfig().aliases)}`);
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full({ naturezaId: '<natureza-id>' })));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  const c = await at(dir);
  const state = c.configState();
  check('one unfilled default is enough to be unconfigured', !state.configured);
  check('and the unfilled key is named, not just counted',
    state.reasons.some((r) => r.includes('naturezaId')), state.reasons.join(' | '));
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full()));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['ExecutanteId', '<your-user-id>']]));
  const c = await at(dir);
  check('a placeholder in the entry template is unconfigured too', !c.configState().configured);
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full()));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  const c = await at(dir);
  check('a complete configuration is configured', c.configState().configured,
    c.configState().reasons.join(' | '));

  /*
   * The MCP layer routes an unconfigured installation to the setup flow by matching
   * `aliases.json` in the message (src/mcp/context.ts). If that prefix ever drifts,
   * the lawyer gets a raw exception instead of being told what to do.
   */
  const other = scratch();
  const d = await at(other);
  let message = '';
  try { d.assertConfigured(); } catch (e) { message = (e as Error).message; }
  check('the refusal is worded so the MCP layer can route it', /aliases\.json/.test(message), message);
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full()));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  const c = await at(dir);
  const before = c.configVersion();

  c.writeConfig({ firm: full({ naturezaId: '99', naturezaText: 'Changed' }) });
  check('a written configuration applies without restarting the process',
    c.firmConfig().defaults.naturezaId === '99', c.firmConfig().defaults.naturezaId);
  check('and the version changes with it, so a stale plan can be detected',
    c.configVersion() !== before);

  const files = readdirSync(dir);
  check('the previous configuration is kept as a backup',
    files.some((f) => f.startsWith('aliases.json.backup-')), files.join(', '));
  check('no half-written file is left behind',
    !files.some((f) => f.endsWith('.writing')), files.join(', '));
  check('what landed on disk is what was read back',
    JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf8')).defaults.naturezaId === '99');
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), '{ this is not json');
  const c = await at(dir);
  let message = '';
  try { c.configState(); } catch (e) { message = (e as Error).message; }
  check('an unreadable configuration fails by name rather than deep in a parser',
    message.includes(dir) || /configuration/i.test(message), message);
}

{
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({ aliases: {}, defaults: {} }));
  const c = await at(dir);
  let message = '';
  try { c.configState(); } catch (e) { message = (e as Error).message; }
  check('a configuration missing required keys names the key',
    /internal|escritorioOrigemId/.test(message), message);
}

{
  process.env['LEGALONE_CONFIG_DIR'] = scratch();
  const { aliasRefusal } = await import('./src/setup.ts');
  const refused = (h: string, r: string, n = 1) => aliasRefusal(h, r, n) !== null;

  check('a head seen with several clients is refused — it names work, not a party',
    refused('Reunião', 'ACME PARTICIPAÇÕES LTDA', 3));
  check('and the refusal says which, so it reads as a finding rather than a gap',
    /3 different registered clients/.test(aliasRefusal('Reunião', 'ACME', 3) ?? ''));
  check('a head already contained in the registered name is refused',
    refused('Acme', 'ACME PARTICIPAÇÕES LTDA'));
  check('accents do not defeat that — the search finds it either way',
    refused('Participações', 'ACME PARTICIPACOES LTDA'));
  check('a registered name carrying a procedural role is refused',
    refused('Fulano', 'FULANO DE TAL (Réu)'));
  check('a registered name naming several parties is refused',
    refused('Fulano', 'FULANO DE TAL e OUTRO'));
  check('a date is not a client name', refused('12/03', 'ACME LTDA'));
  check('a case number is not a client name', refused('0000000-00', 'ACME LTDA'));
  check('a two-character head is refused', refused('JR', 'JOÃO RIBEIRO'));
  check('a genuine drift survives every refusal',
    aliasRefusal('J. Ribeiro', 'João Ribeiro de Souza', 1) === null,
    aliasRefusal('J. Ribeiro', 'João Ribeiro de Souza', 1) ?? '');
}


{
  /*
   * The two gates answer different questions, and conflating them cost a real
   * session its week.
   *
   * `configState` asks whether an entry can be written, which includes the seven
   * template values. `classifyState` asks whether a line can be resolved to a matter,
   * which reads the alias table and the firm contact and never touches the template.
   * The resolver used to consult the first, so `<placeholder>` values that only a POST
   * ever binds refused the plan as well as the write.
   */
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full()));
  // A template shaped like the shipped example: real keys, one value never filled.
  writeFileSync(join(dir, 'template.json'), JSON.stringify([
    ['SituacaoId', '0'],
    ['Executantes[{EXEC}].ExecutanteId', '<your-user-id>'],
  ]));
  const c = await at(dir);

  check('an unset template value refuses a write',
    c.configState().configured === false
      && c.configState().reasons.some((r: string) => /entry template still carries/.test(r)));
  check('...and does not refuse a plan', c.classifyState().configured === true);
  check('...because classification never reads the template',
    c.classifyState().reasons.length === 0);
}

{
  /*
   * The distinction the label exists for: absent alias table versus present-and-empty.
   *
   * An empty table is a decision — aliases are billing decisions and start empty by
   * design. An absent one means nothing has been decided at all, and a name that
   * misses under it has not been looked for so much as looked past.
   */
  const dir = scratch();
  const c = await at(dir);
  check('no configuration at all reports no alias table', c.classifyState().aliasTable === false);

  const dir2 = scratch();
  writeFileSync(join(dir2, 'aliases.json'), JSON.stringify(full()));
  const c2 = await at(dir2);
  check('an empty alias table is still a table', c2.classifyState().aliasTable === true);
}

{
  /*
   * Internal lines need the firm's own contact id and nothing else, so an
   * installation missing only that can still resolve every client line.
   */
  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify(full({ contatoEscritorioId: '<firm-contact-id>' })));
  const c = await at(dir);
  const state = c.classifyState();
  check('an unset firm contact is reported, not thrown',
    state.internal === false && state.aliasTable === true
      && state.reasons.some((r: string) => /contatoEscritorioId/.test(r)));
}


{
  /*
   * A head bound to a matter, which the alias table could not express.
   *
   * An alias maps a head to the name Legal One files it under, which only helps a
   * search find a contact. It has no way to say that every "Rafael Bittencourt"
   * line belongs to matter 1611 — filed under a different person entirely — and a
   * real week of timesheet needed exactly that for six of its clients. Without it
   * the only home for the decision was `decisions` on one log_entries call, re-typed
   * line by line and gone when the call returned.
   */
  const { reloadConfig: reload } = await import('./src/config.ts');
  const { resolveTarget } = await import('./src/resolver.ts');

  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({
    ...full(),
    matters: { 'Rafael Bittencourt': { matterId: 1611, label: '3ª Fase Operação Alvorada' } },
  }));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  process.env['LEGALONE_CONFIG_DIR'] = dir;
  reload();

  let searched = 0;
  const client = {
    searchProcessos: async (term: string) => {
      searched += 1;
      return term === '5001234-56.2025.4.03.6100'
        ? [{ id: 77, cnj: '5001234-56.2025.4.03.6100', pasta: 'Proc - 0000077' }]
        : [];
    },
    searchContatos: async () => [],
  } as never;

  const bound = await resolveTarget(client, 'Rafael Bittencourt — medidas cautelares: revisão da minuta');
  check('a bound head links without searching',
    bound.kind === 'bound' && (bound as any).link.id === 1611 && searched === 0,
    `${bound.kind}, ${searched} search(es)`);
  check('...and carries the label it was bound under, so nothing reads it back',
    (bound as any).link?.text === '3ª Fase Operação Alvorada');

  /*
   * The order that matters: a line carrying its own case number is being more
   * specific than a standing rule about its head, so the number wins. A real
   * timesheet had one line of a bound client that named a different matter's CNJ.
   */
  const specific = await resolveTarget(
    client,
    'Rafael Bittencourt — medidas cautelares 5001234-56.2025.4.03.6100 (TRF3): protocolo',
  );
  check('a CNJ on the line beats the binding for its head',
    specific.kind === 'linked' && (specific as any).link.id === 77,
    `${specific.kind}, id ${(specific as any).link?.id}`);

  const unbound = await resolveTarget(client, 'Alguém Sem Vínculo — alguma coisa');
  check('a head with no binding is unaffected', unbound.kind !== 'bound');
}

{
  /*
   * A CNJ that resolves to nothing must not outrank a binding.
   *
   * Found by booking a real week. Three lines read "Rafael Bittencourt — medidas
   * cautelares 5001234-56.2025.4.03.6100 (TRF3)", and that number is not filed in
   * the tenant at all. The CNJ branch ran, found nothing, and fell straight to
   * "registered, but the matter is not" — about a client whose matter the person had
   * named explicitly ten minutes earlier. A number that resolves is more specific
   * than a rule about a name; a number that resolves to nothing is not.
   */
  const { reloadConfig: reload } = await import('./src/config.ts');
  const { resolveTarget } = await import('./src/resolver.ts');

  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({
    ...full(),
    matters: { 'Rafael Bittencourt': { matterId: 1611, label: 'Proc - 0002468' } },
  }));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  process.env['LEGALONE_CONFIG_DIR'] = dir;
  reload();

  // Nothing is filed under this number, and the contact does exist — the exact
  // shape that produced the wrong verdict.
  const client = { searchProcessos: async () => [], searchContatos: async () => [{ id: 849, nome: 'Rafael Bittencourt Correia Pinto' }] } as never;

  const r = await resolveTarget(client, 'Rafael Bittencourt — medidas cautelares 5001234-56.2025.4.03.6100 (TRF3): revisão');
  check('an unfiled CNJ falls back to the binding, not to matter-missing',
    r.kind === 'bound' && (r as any).link.id === 1611, r.kind);

  // And a head with no binding still reports the honest verdict.
  const other = await resolveTarget(client, 'Outro Cliente — algo 5001234-56.2025.4.03.6101 (TRF3): revisão');
  check('...while an unbound head still reports matter-missing', other.kind === 'matter-missing', other.kind);
}

{
  /*
   * A decision that stopped applying has to say so.
   *
   * Found by booking the following week. The binding was keyed "Rafael Bittencourt";
   * that week's timesheet wrote "Rafael Bittencourt Correia Pinto". The binding
   * did not fire — correctly, since only the person can say two names are one client —
   * and the three lines came back "registered, but the matter is not", which reads
   * exactly like a client nobody has ever decided anything about. Held is the right
   * outcome; held in silence is not.
   */
  const { reloadConfig: reload } = await import('./src/config.ts');
  const { resolveTarget, nearBinding } = await import('./src/resolver.ts');
  const { executePlan } = await import('./src/execute.ts');

  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({
    ...full(),
    matters: { 'Rafael Bittencourt': { matterId: 1611, label: 'Proc - 0002468/001' } },
  }));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  process.env['LEGALONE_CONFIG_DIR'] = dir;
  reload();

  check('a longer form of a bound head is noticed',
    (nearBinding('Rafael Bittencourt Correia Pinto') ?? '').includes('1611'));
  check('...and says it was not applied, because only the person can say so',
    (nearBinding('Rafael Bittencourt Correia Pinto') ?? '').includes('NOT applied'));
  check('a shorter form is noticed too — the drift runs both ways',
    nearBinding('Rafael Bittencourt Correia') !== null);
  check('the bound head itself is not near itself', nearBinding('Rafael Bittencourt') === null);
  check('a name that merely shares a prefix is not near it',
    nearBinding('Rafael Bittencourts') === null, 'word boundary');
  check('an unrelated head is not near it', nearBinding('Outro Cliente') === null);
  check('no head at all is not near anything', nearBinding(null) === null);

  /*
   * The whole point is that it reaches the report someone reads. A held line that
   * mentions nothing is the failure this case exists to prevent.
   */
  const client = {
    searchProcessos: async () => [],
    searchContatos: async () => [{ id: 849, nome: 'Rafael Bittencourt Correia Pinto' }],
    listEntries: async () => [],
  } as never;
  const line = {
    date: '10/08/2026', startTime: '09:00:00', endTime: '09:30:00',
    description: 'Rafael Bittencourt Correia Pinto — medidas cautelares 5001234-56.2025.4.03.6100 (TRF3): alinhamento',
  };
  const [planned] = await (await import('./src/resolver.ts')).planEntries(client, [line]);
  check('the head that drifted still holds, rather than being guessed at',
    planned!.resolution.kind === 'matter-missing', planned!.resolution.kind);

  const run = await executePlan(client, [planned!], { dryRun: true });
  check('and the held line names the binding it nearly matched',
    run.outcomes[0]!.status === 'held' && run.outcomes[0]!.detail.includes('standing binding for "Rafael Bittencourt"'),
    run.outcomes[0]!.detail);

  const decided = await resolveTarget(client, 'Rafael Bittencourt — medidas cautelares: alinhamento');
  check('the exact head still binds without any of this firing', decided.kind === 'bound');
}

{
  /*
   * A head bound to a contact rather than to a matter.
   *
   * "Every Marcelo Duarte line goes on Helena Nogueira's contact — do not open a
   * folder, and do not force his inquérito into one of Nogueira's six" is an answer the
   * configuration had no way to hold. `matters` resolved only to matters, so recording
   * it meant picking one of those six: filing the work under a case it has nothing to
   * do with, which is the failure this table exists to prevent, arrived at by obeying
   * the table.
   */
  const { reloadConfig: reload, bindingTarget } = await import('./src/config.ts');
  const { resolveTarget } = await import('./src/resolver.ts');
  const { resolveBindings } = await import('./src/mcp/tools-config.ts');

  const dir = scratch();
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({
    ...full(),
    matters: {
      'Marcelo Duarte': { contactId: 428, label: 'Helena Nogueira' },
      'AGROLINHA / Vilson Prado Meireles': { matterId: 1141, label: 'Proc - 0000912' },
    },
  }));
  writeFileSync(join(dir, 'template.json'), JSON.stringify([['SituacaoId', '0']]));
  process.env['LEGALONE_CONFIG_DIR'] = dir;
  reload();

  check('a contact binding survives the schema and reads back as a contact link',
    bindingTarget({ contactId: 428, label: 'Helena Nogueira' }).kind === 'contato');
  check('...and a matter binding still reads back as a matter link',
    bindingTarget({ matterId: 1141, label: 'Proc - 0000912' }).kind === 'processo');

  const nothing = { searchProcessos: async () => [], searchContatos: async () => [] } as never;
  const caseri = await resolveTarget(nothing, 'Marcelo Duarte — IP de perseguição (TJSP): triagem');
  check('a head bound to a contact links to that contact, not to a matter',
    caseri.kind === 'bound' && (caseri as any).link.kind === 'contato' && (caseri as any).link.id === 428,
    `${caseri.kind} ${(caseri as any).link?.kind} ${(caseri as any).link?.id}`);

  /*
   * The precedence a contact binding must not change: a line carrying its own case
   * number is more specific than a rule about its head, whatever kind the rule names.
   */
  const withCnj = {
    searchProcessos: async () => [{ id: 903, cnj: '1002345-67.2016.8.26.0100', pasta: 'Proc - 0000631' }],
    searchContatos: async () => [],
  } as never;
  const specific = await resolveTarget(withCnj, 'Marcelo Duarte — algo 1002345-67.2016.8.26.0100: revisão');
  check('a CNJ on the line still beats a contact binding',
    specific.kind === 'linked' && (specific as any).link.id === 903, specific.kind);

  /*
   * The prefix is required, and one hit or nothing. A binding that quietly picked the
   * first of several contacts would send a client's whole year somewhere nobody chose.
   */
  const contacts = (list: Array<{ id: number; nome: string }>) =>
    ({ searchProcessos: async () => [], searchContatos: async () => list, readMatter: async () => null } as never);

  const one = await resolveBindings(contacts([{ id: 428, nome: 'Helena Nogueira' }]),
    { 'Marcelo Duarte': 'contato: Helena Nogueira' });
  check('"contato: <name>" binds to the one contact it names',
    (one.bound['Marcelo Duarte'] as any)?.contactId === 428 && one.failures.length === 0,
    JSON.stringify(one.failures));
  check('...and the outcome says it was read as a contact',
    one.outcomes[0]?.via === 'contact');

  const many = await resolveBindings(contacts([{ id: 1, nome: 'A' }, { id: 2, nome: 'B' }]),
    { 'X': 'contato: ambíguo' });
  check('two contacts is a refusal, not a first hit',
    many.failures.length === 1 && Object.keys(many.bound).length === 0);

  const none = await resolveBindings(contacts([]), { 'X': 'contact: ninguém' });
  check('no contact is a refusal too', none.failures.length === 1);

  const bare = await resolveBindings(contacts([{ id: 428, nome: 'Helena Nogueira' }]),
    { 'X': 'Helena Nogueira' });
  check('a bare name is NOT read as a contact — the prefix is the whole signal',
    bare.failures.length === 1 && Object.keys(bare.bound).length === 0, JSON.stringify(bare.outcomes));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
