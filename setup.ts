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
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { LegalOneTimesheet, type Link } from './src/client.ts';
import { browserSession, LoginRequiredError } from './src/session.ts';
import { diagnose, format as formatDiagnosis } from './src/doctor.ts';
import { discover, format as formatDiscovery, type Discovery } from './src/setup.ts';
import { generateTemplate, format as formatTemplate } from './src/template.ts';

import { configDir, entryTemplate, firmConfig, templatePath, writeConfig } from './src/config.ts';

const write = process.argv.includes('--write');
const say = (s = '') => console.log(s);

const findingFor = (d: Discovery, key: string) => d.findings.find((f) => f.key === key);

/** A value that is still a placeholder is not a value. */
const usable = (v: string | undefined): boolean => !!v && !/^<.*>$/.test(v);

/**
 * Whether the firm's own records actually settle a value.
 *
 * They often do not, and the reason is worth understanding rather than averaging
 * away. `discover` samples the matters *this user books time to*, which is an
 * excellent frame for finding their executante or their área — those are attributes
 * of the user, and they came back unanimous. It is a biased frame for the firm's
 * default responsável: you are disproportionately the responsável on your own
 * matters, while the config answers a different question — who goes on a matter the
 * firm files next. That is policy, not a statistic over one person's work.
 *
 * So a mode is a proposal, never a decision. Anything contested keeps whatever is
 * already configured and is reported as pending.
 */
const settled = (d: Discovery, key: string): { value: string; text: string } | null => {
  const finding = findingFor(d, key);
  if (!finding?.best) return null;
  if (finding.candidates.length > 1) return null;  // the records disagree
  if (finding.sampled < 2) return null;            // a sample of one is not evidence
  return { value: finding.best.value, text: finding.best.text };
};

const contestedWhy = (d: Discovery, key: string): string => {
  const finding = findingFor(d, key);
  if (!finding?.best) return 'nothing found in the sampled records';
  if (finding.candidates.length > 1) {
    return `the records disagree: ${finding.candidates.map((c) => `${c.value}${c.text ? ` (${c.text.slice(0, 32)})` : ''} ×${c.count}`).join(', ')}`;
  }
  return 'only one record carried it, so this is a sample of one';
};

export type Adoption =
  | { key: string; verdict: 'adopted'; value: string; why: string }
  | { key: string; verdict: 'by hand'; value: string; why: string }
  | { key: string; verdict: 'kept'; value: string; why: string }
  | { key: string; verdict: 'unresolved'; why: string };

/** `--set key=value` settles a field the records could not. */
const overrides = (): Record<string, string> =>
  Object.fromEntries(
    process.argv
      .filter((a) => a.startsWith('--set='))
      .map((a) => a.slice('--set='.length).split('='))
      .filter((pair): pair is [string, string] => pair.length === 2 && !!pair[0] && !!pair[1]),
  );

/**
 * Folds discovered values into the config, preserving everything that is not
 * derivable — and everything the records could not settle.
 *
 * `aliases` is the reason this reads before it writes. A firm's alias table is
 * billing-relevant and cannot be inferred; overwriting one would silently redirect
 * hours. Same for `internal.prefixes` and `titleFormat`: conventions a person chose.
 */
function mergeAliases(discovery: Discovery, answered: Record<string, string> = {}): {
  merged: Record<string, unknown>;
  kept: string[];
  adoptions: Adoption[];
} {
  /*
   * The base is what is configured, and when nothing is, it is empty — never the
   * example. Basing on the example is how three fictional aliases (`Acme`,
   * `J. Ribeiro`, `Fintech Co`) used to be written into a live configuration and
   * reported as `kept 3 aliases`, after which a real client name was rewritten to a
   * company that does not exist and the search reported it unregistered.
   */
  const base = structuredClone(firmConfig()) as unknown as Record<string, unknown>;
  const kept: string[] = [];
  const aliases = (base['aliases'] ?? {}) as Record<string, string>;
  if (Object.keys(aliases).length > 0) kept.push(`${Object.keys(aliases).length} aliases`);
  if (base['titleFormat']) kept.push('titleFormat');

  const defaults = { ...(base['defaults'] as Record<string, string>) };
  const chosen = { ...answered, ...overrides() };
  const adoptions: Adoption[] = [];

  const put = (idKey: string, textKey: string) => {
    if (chosen[idKey]) {
      defaults[idKey] = chosen[idKey]!;
      const match = findingFor(discovery, idKey)?.candidates.find((c) => c.value === chosen[idKey]);
      if (match?.text) defaults[textKey] = match.text;
      adoptions.push({ key: idKey, verdict: 'by hand', value: chosen[idKey]!, why: '--set on the command line' });
      return;
    }
    const agreed = settled(discovery, idKey);
    if (agreed) {
      defaults[idKey] = agreed.value;
      if (agreed.text) defaults[textKey] = agreed.text;
      adoptions.push({ key: idKey, verdict: 'adopted', value: agreed.value, why: 'the records agree' });
      return;
    }
    const why = contestedWhy(discovery, idKey);
    if (usable(defaults[idKey])) {
      adoptions.push({ key: idKey, verdict: 'kept', value: defaults[idKey]!, why });
    } else {
      adoptions.push({ key: idKey, verdict: 'unresolved', why });
    }
  };

  put('contatoEscritorioId', 'contatoEscritorioText');
  put('escritorioOrigemId', 'escritorioOrigemText');
  put('escritorioResponsavelId', 'escritorioResponsavelText');
  put('responsavelId', 'responsavelText');
  put('responsavelPosicaoId', 'responsavelPosicaoText');
  put('naturezaId', 'naturezaText');

  return { merged: { ...base, defaults }, kept, adoptions };
}

/**
 * Asks about the values the firm's own records could not settle.
 *
 * Only when someone is actually at a terminal. Everywhere else — an agent, CI, a
 * redirected run — the questions are reported and the process returns, which is the
 * same shape `login-required` already uses for "a person is needed here". Blocking
 * on stdin that nobody will type into is the one behaviour that is never right.
 *
 * A flag alone was not enough. `--set=responsavelId=38` asks someone to know that 38
 * is a particular lawyer; the evidence is on screen with names attached, and picking
 * from a list is the part a person can do without translation.
 */
async function askContested(discovery: Discovery, adoptions: Adoption[]): Promise<Record<string, string>> {
  const open = adoptions.filter((a) => a.verdict === 'kept' || a.verdict === 'unresolved');
  if (open.length === 0) return {};

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers: Record<string, string> = {};
  try {
    for (const adoption of open) {
      const finding = findingFor(discovery, adoption.key);
      const options = finding?.candidates ?? [];
      const current = adoption.verdict === 'kept' ? adoption.value : null;

      say();
      say(`${finding?.label ?? adoption.key} — ${adoption.why}`);
      say();
      options.forEach((c, i) => {
        say(`  ${i + 1}) ${c.value.padEnd(6)} ${c.text.slice(0, 56).padEnd(58)} ${c.count} record(s)`);
      });
      if (current) say(`  ${options.length + 1}) keep what is configured (${current})`);
      if (adoption.key === 'responsavelId') {
        say();
        say('  Note: the sample is the matters you book time to, so it leans toward');
        say('  whoever is responsável on your own work — not necessarily the default');
        say('  for a matter the firm files next.');
      }
      say();

      for (;;) {
        const raw = (await rl.question('  > ')).trim();
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) { answers[adoption.key] = options[n - 1]!.value; break; }
        if (current && n === options.length + 1) break; // keep: no override needed
        say(`  Pick 1–${options.length + (current ? 1 : 0)}.`);
      }
    }
  } finally {
    rl.close();
  }
  return answers;
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
  /*
   * The elapsed prefix is the point. A cold profile takes over a minute to reach
   * "sign in required" — a new browser, then a redirect chain across two identity
   * providers — and printed nothing at all, which reads as a hang rather than as
   * work. A person who cannot tell those apart kills the process.
   */
  const started = Date.now();
  const session = browserSession({
    onProgress: (m) => say(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${m}`),
  });
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

  const installed = existsSync(templatePath())
    ? entryTemplate()
    : [];
  say('— comparing the entry form against the installed template —');
  const candidate = await generateTemplate(client, installed);
  say(formatTemplate(candidate));
  say();

  let { merged, kept, adoptions } = mergeAliases(discovery);
  const report = (label: string) => {
    say(`— ${label} —`);
    for (const a of adoptions) {
      const shown = a.verdict === 'unresolved' ? '(none)' : a.value;
      say(`  ${a.verdict.padEnd(11)} ${a.key.padEnd(24)} ${shown.padEnd(8)} ${a.why}`);
    }
    say();
  };
  report('what would be written');

  const contested = () => adoptions.filter((a) => a.verdict === 'kept' || a.verdict === 'unresolved');

  if (!write) {
    if (contested().length > 0) {
      say('The firm\'s records do not settle every value, and a mode is not a decision.');
      say('Re-run with --write and you will be asked, or answer up front:');
      say('  bun run setup --write --set=responsavelId=38');
      say();
    }
    say('Nothing was written. Re-run with --write to commit this and prove it with a probe entry.');
    return 0;
  }

  if (contested().length > 0) {
    if (process.stdin.isTTY) {
      const answers = await askContested(discovery, contested());
      if (Object.keys(answers).length > 0) {
        ({ merged, kept, adoptions } = mergeAliases(discovery, answers));
        say();
        report('what will be written');
      }
    } else {
      say('These values are not settled by the records, and nobody is at a terminal to decide:');
      for (const a of contested()) say(`  ${a.key.padEnd(24)} ${a.why}`);
      say();
      say('Answer them and run again, for example:  --set=responsavelId=38');
      return 3;
    }
  }

  const defaults = merged['defaults'] as Record<string, string>;
  const unresolved = adoptions.filter((a) => a.verdict === 'unresolved');
  const held = adoptions.filter((a) => a.verdict === 'kept');

  if (unresolved.length > 0) {
    say(`Refusing to write: ${unresolved.map((a) => a.key).join(', ')} could not be settled and have no usable`);
    say('existing value. Writing a half-configured file would fail later, further from the cause.');
    return 1;
  }

  const files = writeConfig({ firm: merged });
  say(`wrote ${files.join(', ')}${kept.length > 0 ? ` (kept ${kept.join(', ')})` : ''}`);
  say('  aliases were not touched: a wrong one books hours against the wrong client, and nothing surfaces it.');
  if (held.length > 0) {
    say(`  ${held.length} value(s) left as they were, because the records contest them: ${held.map((a) => a.key).join(', ')}`);
  }

  say();
  say('— proving it —');
  await selfTest(client, {
    kind: 'contato',
    id: Number(defaults['contatoEscritorioId']),
    text: defaults['contatoEscritorioText'] ?? '',
  });

  say();
  say('Done. Run again to re-check, or run the gates:');
  say('  bun run session-check.ts && bun run execute-check.ts');
  say(`Configuration lives in ${configDir()}, outside this clone — deleting the repository does not delete it.`);
  return 0;
}

process.exit(await main());
