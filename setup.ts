/*
 * Configures this client for a firm, by reading what the firm already has.
 *
 * Run it with no arguments and it changes nothing: it signs in, checks that this
 * client's assumptions hold on the tenant, reads a configuration off the firm's own
 * records, and shows you the evidence. `--write` is what actually commits, and then
 * proves the result by booking one entry, reading it back and deleting it.
 *
 * The confirmation is a flag rather than a prompt on purpose. A prompt cannot be
 * answered when this runs inside an agent, and "it asked and nobody was there" is a
 * bad reason to either stall or proceed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LegalOneTimesheet, type Link } from './src/client.ts';
import { browserSession, LoginRequiredError } from './src/session.ts';
import { diagnose, format as formatDiagnosis } from './src/doctor.ts';
import { discover, format as formatDiscovery, type Discovery } from './src/setup.ts';
import { generateTemplate, format as formatTemplate } from './src/template.ts';

const ALIASES = new URL('src/aliases.json', import.meta.url);
const TEMPLATE = new URL('src/template.json', import.meta.url);
const EXAMPLE = new URL('src/aliases.example.json', import.meta.url);

const write = process.argv.includes('--write');
const say = (s = '') => console.log(s);

const bestOf = (d: Discovery, key: string): { value: string; text: string } | null => {
  const found = d.findings.find((f) => f.key === key)?.best;
  return found ? { value: found.value, text: found.text } : null;
};

/**
 * Folds discovered values into the config, preserving everything that is not
 * derivable.
 *
 * `aliases` is the reason this reads before it writes. A firm's alias table is
 * billing-relevant and cannot be inferred — overwriting one would silently redirect
 * hours. Same for `internal.prefixes` and `titleFormat`: conventions a person chose.
 * Only `defaults` is replaced.
 */
function mergeAliases(discovery: Discovery): { merged: Record<string, unknown>; kept: string[] } {
  const base = JSON.parse(readFileSync(existsSync(ALIASES) ? ALIASES : EXAMPLE, 'utf8')) as Record<string, unknown>;
  const kept: string[] = [];
  const aliases = (base['aliases'] ?? {}) as Record<string, string>;
  if (Object.keys(aliases).length > 0) kept.push(`${Object.keys(aliases).length} aliases`);
  if (base['titleFormat']) kept.push('titleFormat');

  const defaults = { ...(base['defaults'] as Record<string, string>) };
  const put = (idKey: string, textKey: string, discovered: string) => {
    const hit = bestOf(discovery, discovered);
    if (!hit) return;
    defaults[idKey] = hit.value;
    if (hit.text) defaults[textKey] = hit.text;
  };
  put('contatoEscritorioId', 'contatoEscritorioText', 'contatoEscritorioId');
  put('escritorioId', 'escritorioText', 'escritorioId');
  put('responsavelId', 'responsavelText', 'responsavelId');
  put('responsavelPosicaoId', 'responsavelPosicaoText', 'responsavelPosicaoId');
  put('naturezaId', 'naturezaText', 'naturezaId');

  return { merged: { ...base, defaults }, kept };
}

/**
 * Books one entry, reads it back, and deletes it.
 *
 * On a tenant with no captured fixture there is no `verify.ts` to grade a
 * configuration, and a configuration that looks right and files hours wrong is the
 * failure this whole codebase is organised against. Entries can be deleted; matters
 * cannot, which is why the probe is an entry.
 */
async function selfTest(client: LegalOneTimesheet, link: Link): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const marker = `[setup self-test ${stamp}] safe to delete`;
  const today = new Date();
  const date = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  say(`  booking a probe entry on ${date} 00:00–00:01…`);
  const id = await client.create({ date, startTime: '00:00:00', endTime: '00:01:00', description: marker, link });

  try {
    const { pairs } = await client.readFormPairs(`/TimeSheet/HorasTrabalhadas/EditHoraTrabalhada/${id}`);
    const value = (name: string) => pairs.find(([k]) => k === name || k.split('.').pop() === name)?.[1] ?? '';
    const mismatches = [
      ['DtInicio', date],
      ['HrInicio', '00:00:00'],
      ['HrTermino', '00:01:00'],
      ['DescricaoHT', marker],
    ].filter(([name, want]) => value(name!) !== want);

    if (mismatches.length > 0) {
      throw new Error(
        `entry ${id} came back different from what was sent: ` +
          mismatches.map(([n, w]) => `${n} wanted "${w}", got "${value(n!)}"`).join('; '),
      );
    }
    say(`  entry ${id} round-tripped: date, both times and description all match.`);
  } finally {
    await client.delete(id);
    say(`  probe entry ${id} deleted.`);
  }
}

async function main(): Promise<number> {
  const session = browserSession();
  let cookie: string;
  try {
    cookie = await session.cookie();
  } catch (error) {
    if (error instanceof LoginRequiredError) {
      say('Sign in required.');
      say(`A browser window is open at ${error.url}. Sign in there, then run this again.`);
      return 2;
    }
    throw error;
  }
  const tenant = session.tenant()!;
  say(`tenant: ${tenant}`);
  say();

  const client = new LegalOneTimesheet({ baseUrl: tenant, cookie: () => session.cookie() });

  say('— checking this client\'s assumptions against the tenant —');
  const diagnosis = await diagnose(client);
  say(formatDiagnosis(diagnosis));
  say();
  if (diagnosis.fail > 0) {
    say('Refusing to configure a tenant where an assumption this client is built on does not hold.');
    say('Configuring now would produce a setup that looks right and files hours wrong.');
    return 1;
  }

  say('— reading a configuration off the firm\'s own records —');
  const discovery = await discover(client, { days: 120 });
  say(formatDiscovery(discovery));
  say();

  const installed = existsSync(TEMPLATE)
    ? (JSON.parse(readFileSync(TEMPLATE, 'utf8')) as Array<[string, string]>)
    : [];
  say('— comparing the entry form against the installed template —');
  const candidate = await generateTemplate(client, installed);
  say(formatTemplate(candidate));
  say();

  const contato = bestOf(discovery, 'contatoEscritorioId');
  if (!contato) {
    say('No firm contact could be found, so internal time has nowhere to book and the probe cannot run.');
    return 1;
  }

  if (!write) {
    say('Nothing was written. Re-run with --write to commit this and prove it with a probe entry.');
    return 0;
  }

  const { merged, kept } = mergeAliases(discovery);
  writeFileSync(ALIASES, `${JSON.stringify(merged, null, 2)}\n`);
  say(`wrote src/aliases.json${kept.length > 0 ? ` (kept ${kept.join(', ')})` : ''}`);
  say('  aliases were not touched: a wrong one books hours against the wrong client, and nothing surfaces it.');

  say();
  say('— proving it —');
  await selfTest(client, { kind: 'contato', id: Number(contato.value), text: contato.text });

  say();
  say('Done. Run again to re-check, or run the gates:');
  say('  bun run session-check.ts && bun run execute-check.ts');
  say('This process still holds the previous configuration in memory — the new values apply on the next run.');
  return 0;
}

process.exit(await main());
