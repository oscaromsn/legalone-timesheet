/*
 * Configuring an installation from a conversation.
 *
 * This is the half that was missing. Everything else here could be driven by an
 * agent; configuration could only be proposed, and adopting a proposal meant
 * `bun run setup --write` in a terminal — which, for the person this is built for,
 * means it never happens. The bundle they install carries no such command at all.
 *
 * Two tools, in the shape `propose_matter`/`create_matter` already established: one
 * derives and shows, the other takes the same inputs plus a token and writes. The
 * token is deliberately weaker than it looks, and the re-derivation is what carries
 * the guarantee — see `apply_config`.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { read } from '../auth.ts';
import {
  configState,
  configVersion,
  entryTemplate,
  firmConfig,
  writeConfig,
  type EntryTemplate,
  type FirmConfig,
} from '../config.ts';
import { discover, discoverAliases, format as formatDiscovery, templateValuesFrom } from '../setup.ts';
import { context, guard, type ToolResult } from './context.ts';
import type { Tool } from './tools-read.ts';

/** The values the create template carries that a firm's own records can supply. */
const TEMPLATE_LEAVES = [
  'ExecutanteId', 'ExecutanteText',
  'AreaId', 'AreaText',
  'TabelaValoresId', 'TabelaValoresText',
  'ValorHoraCobranca',
] as const;

const leafOf = (key: string): string => key.split('.').pop() ?? key;

/** Sorts every level, so two logically identical proposals hash identically. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/**
 * Binds a confirmation to the payload *and to the configuration it was derived from*.
 *
 * `create_matter`'s token binds only the answers, which is enough there because a
 * matter has no previous version to lose. A configuration does: a second writer —
 * another conversation, or `setup --write` in a terminal — would otherwise have its
 * work reverted by a token that still matches an older base. Hashing the base in
 * makes a concurrent write invalidate the token instead.
 */
const configToken = (payload: unknown, base: string): string =>
  createHash('sha256').update(JSON.stringify(canonical(payload))).update(base).digest('hex').slice(0, 16);

const proposalArgs = {
  days: z.number().int().min(1).max(730).default(120),
  aliases: z.record(z.string(), z.string()).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
  templateValues: z.record(z.string(), z.string()).optional(),
  internalPrefixes: z.array(z.string()).optional(),
  titleFormat: z.string().nullable().optional(),
};

type ProposalArgs = {
  days: number;
  aliases?: Record<string, string>;
  overrides?: Record<string, string>;
  templateValues?: Record<string, string>;
  internalPrefixes?: string[];
  titleFormat?: string | null;
};

/** The six ids a firm's records can settle, and the key each fills. */
const SETTLED_KEYS = [
  'contatoEscritorioId', 'escritorioOrigemId', 'escritorioResponsavelId',
  'responsavelId', 'responsavelPosicaoId', 'naturezaId',
] as const;

interface Built {
  firm: FirmConfig;
  template: EntryTemplate;
  unresolved: string[];
  evidence: Array<{ key: string; value: string; text: string; agreed: number; of: number; contested: boolean }>;
  discovery: Awaited<ReturnType<typeof discover>>;
}

/** Assembles the configuration a proposal would write. Pure, given the discovery. */
const build = (
  discovery: Awaited<ReturnType<typeof discover>>,
  args: ProposalArgs,
): Built => {
  const current = firmConfig();
  // The schema is loose, so unknown keys (the `_comment` fields) carry `unknown`.
  const defaults: Record<string, unknown> = { ...current.defaults };
  const evidence: Built['evidence'] = [];
  const unresolved: string[] = [];

  for (const key of SETTLED_KEYS) {
    const found = discovery.findings.find((f) => f.key === key);
    const chosen = args.overrides?.[key];
    if (chosen) {
      defaults[key] = chosen;
      const text: string = found?.candidates.find((c) => c.value === chosen)?.text ?? '';
      if (text) defaults[key.replace(/Id$/, 'Text')] = text;
      evidence.push({ key, value: chosen, text, agreed: 0, of: found?.sampled ?? 0, contested: false });
      continue;
    }
    const best = found?.best ?? null;
    if (!best) { unresolved.push(key); continue; }
    defaults[key] = best.value;
    if (best.text) defaults[key.replace(/Id$/, 'Text')] = best.text;
    evidence.push({
      key, value: best.value, text: best.text,
      agreed: best.count, of: found!.sampled,
      contested: (found!.candidates.length ?? 0) > 1,
    });
  }

  /*
   * The firm's own records settle four of the seven template values, and until now
   * nothing carried them across: `propose_config` printed them in its report and
   * listed them under `templateValuesNeeded` in the same answer, as though unknown.
   *
   * Anything the caller passed wins, because that is a person's decision over a
   * statistic. Shared with `setup --write` so both paths write the same file.
   */
  const values = { ...templateValuesFrom(discovery), ...args.templateValues };
  const template: EntryTemplate = entryTemplate().map(([k, v]) => {
    const replacement = values[leafOf(k)];
    return replacement === undefined ? [k, v] : [k, replacement];
  });

  const firm: FirmConfig = {
    ...current,
    aliases: args.aliases ?? current.aliases,
    internal: { ...current.internal, prefixes: args.internalPrefixes ?? current.internal.prefixes },
    defaults: defaults as FirmConfig['defaults'],
    titleFormat: args.titleFormat === undefined ? current.titleFormat : args.titleFormat,
    provisional: true,
  };
  return { firm, template, unresolved, evidence, discovery };
};

const payloadOf = (args: ProposalArgs) => ({
  days: args.days,
  aliases: args.aliases ?? null,
  overrides: args.overrides ?? null,
  templateValues: args.templateValues ?? null,
  internalPrefixes: args.internalPrefixes ?? null,
  titleFormat: args.titleFormat === undefined ? null : args.titleFormat,
});

export const configTools: Tool[] = [
  {
    name: 'propose_config',
    description:
      'Reads the firm\'s own records and proposes a complete configuration — the ids every entry carries, and the ' +
      'alias table that maps the names a timesheet uses to the names Legal One files them under. Writes nothing. ' +
      'Call it with no arguments first to see the evidence, then again carrying the aliases and choices a person ' +
      'approved, which returns the confirmationToken apply_config needs. Alias candidates are approved one at a ' +
      'time, never in a block: each one rewrites every future line whose description begins with that name.',
    schema: proposalArgs,
    run: (args: ProposalArgs) => guard(async () => {
      const { client } = await context();
      const discovery = await read(() => discover(client, { days: args.days }), () => Promise.resolve());
      const aliasScan = await read(() => discoverAliases(client, { days: args.days }), () => Promise.resolve());
      const built = build(discovery, args);
      const complete = built.unresolved.length === 0;
      return {
        ok: true,
        entriesSampled: discovery.entriesSampled,
        mattersSampled: discovery.mattersSampled,
        evidence: built.evidence,
        unresolved: built.unresolved,
        warnings: discovery.warnings,
        aliasCandidates: aliasScan.candidates,
        aliasRefusals: aliasScan.refused,
        aliasUnpaired: aliasScan.unpaired,
        /*
         * Measured against the template this proposal would write, not the one
         * installed. They differ now that the firm's records fill four of these, and
         * reporting the installed one listed values as needed in the same breath as
         * the report printed them.
         */
        templateValuesNeeded: TEMPLATE_LEAVES.filter(
          (leaf) => built.template.some(([k, v]) => leafOf(k) === leaf && /^<.*>$/.test(v)),
        ),
        report: formatDiscovery(discovery),
        ...(complete
          ? {
              confirmationToken: configToken(payloadOf(args), configVersion()),
              note:
                'Pass these exact arguments and this token to apply_config. Any change to them, or any change to ' +
                'the configuration already on disk, invalidates it.',
            }
          : {
              note:
                'The records do not settle every value. Ask the person about what is listed in `unresolved`, using ' +
                'lookup to show the tenant\'s real options, then call again with those in `overrides`.',
            }),
      } satisfies ToolResult;
    }),
  },
  {
    name: 'apply_config',
    description:
      'Writes the configuration that propose_config issued a token for, and it takes effect immediately — nothing ' +
      'needs restarting. Re-derives the proposal from the tenant before writing and refuses if the evidence moved, ' +
      'so a proposal a person approved five minutes ago cannot be written against records that have changed since. ' +
      'Keeps a dated backup. The configuration it writes is marked provisional, which is not a refusal: the next ' +
      'log_entries files the first real line, reads it back field by field, and stops there so a person can look ' +
      'at it in Legal One. That read-back is the proof, and passing it clears the mark.',
    schema: { ...proposalArgs, confirmationToken: z.string().min(1) },
    run: (args: ProposalArgs & { confirmationToken: string }) => guard(async () => {
      const { client } = await context();
      const base = configVersion();
      const expected = configToken(payloadOf(args), base);
      if (expected !== args.confirmationToken) {
        return {
          ok: false,
          error: 'the confirmation token does not match these arguments',
          hint:
            'Either the arguments changed since propose_config issued it, or the configuration on disk did — ' +
            'another conversation or a terminal may have written one. Call propose_config again, show the person ' +
            'what it now proposes, and use the new token.',
        };
      }

      /*
       * The token proves the agent did not change its mind. It cannot prove the
       * tenant did not change, and between a proposal and its approval a person can
       * book entries, administrative can rename a contact, and the sampling window
       * can roll over midnight. So the proposal is derived again and compared.
       */
      const discovery = await read(() => discover(client, { days: args.days }), () => Promise.resolve());
      const built = build(discovery, args);
      if (built.unresolved.length > 0) {
        return {
          ok: false,
          error: `the tenant no longer settles: ${built.unresolved.join(', ')}`,
          hint: 'The records moved since the proposal. Call propose_config again and show the person what changed.',
        };
      }

      /*
       * A template with holes in it is not a configuration, and writing one was worse
       * than refusing: apply_config returned ok, reported `configured: false` in a
       * field beside it, and left seven `<placeholder>` strings on disk that the next
       * booking would POST — for a 405 about int binding, naming neither the file nor
       * the field. Refusing here keeps "it applied" and "it works" from diverging.
       */
      const holes = TEMPLATE_LEAVES.filter(
        (leaf) => built.template.some(([k, v]) => leafOf(k) === leaf && /^<.*>$/.test(v)),
      );
      if (holes.length > 0) {
        return {
          ok: false,
          error: `the entry template would still be unset: ${holes.join(', ')}`,
          hint:
            'Nothing was written. These come from the firm\'s own records when they settle them; where they do ' +
            'not, pass them in templateValues and call propose_config again for a token that covers them. Do ' +
            'not invent values — a placeholder posted to Legal One fails with a message naming neither.',
        };
      }

      const files = writeConfig({ firm: built.firm, template: built.template });
      const state = configState();
      return {
        ok: true,
        wrote: files,
        configVersion: configVersion(),
        configured: state.configured,
        reasons: state.reasons,
        provisional: true,
        aliasesWritten: Object.keys(built.firm.aliases).length,
        note:
          'In force now — no restart. It is marked provisional, meaning it has never been checked against Legal ' +
          'One: the next log_entries files ONE real line, reads it back field by field and stops. Show the person ' +
          'that entry and let them look at it, then call log_entries again for the rest. If the read-back ' +
          'disagrees the line is deleted and the mark stays.',
      } satisfies ToolResult;
    }),
  },
];
