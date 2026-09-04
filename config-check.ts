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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
