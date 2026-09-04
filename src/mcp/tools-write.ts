/*
 * Everything that changes something, plus the diagnostics.
 *
 * The asymmetry here is deliberate and comes from the library. Entries can be
 * deleted, so writing one is recoverable and goes straight through. Matters cannot,
 * and `createMatter` only verifies that one matter now matches the number — never
 * what is inside it — so creating one is gated.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idempotentWrite, read } from '../auth.ts';
import { planEntries } from '../resolver.ts';
import { executePlan, entryKey, format as formatRun, type Decision } from '../execute.ts';
import { proposeMatter, validateAnswers, createFromProposal } from '../interview.ts';
import { diagnose, format as formatDoctor } from '../doctor.ts';
import { configProvisional, configVersion } from '../config.ts';
import { context, guard, type ToolResult } from './context.ts';
import type { Tool } from './tools-read.ts';

const dateArg = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'dd/MM/yyyy');
const timeArg = z.string().regex(/^\d{2}:\d{2}:\d{2}$/, 'HH:mm:ss');
const lineArg = z.object({ date: dateArg, startTime: timeArg, endTime: timeArg, description: z.string().min(1) });

/**
 * Binds a confirmation to exactly the answers it was shown for.
 *
 * Not ceremony: it makes it impossible to confirm one thing and write another. An
 * agent that presented a set of answers to a person and then submitted a different
 * set — by mistake, or by reconsidering mid-conversation — is refused, and a matter
 * cannot be deleted afterwards.
 */
const tokenFor = (answers: Record<string, string>): string => {
  const canonical = JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

export const writeTools: Tool[] = [
  {
    name: 'plan_entries',
    description:
      'Classifies timesheet lines against Legal One without writing anything. Every line comes back linked, ' +
      'internal, matter-missing, ambiguous or escalate. Run this before log_entries and show the result to the ' +
      'person — the states it refuses to decide are the ones where a wrong guess bills the wrong client silently.',
    schema: { lines: z.array(lineArg).min(1) },
    run: ({ lines }) => guard(async () => {
      const { client, renew } = await context();
      const planned = await read(() => planEntries(client, lines), renew);
      return {
        ok: true,
        configVersion: configVersion(),
        entries: planned.map((p) => ({
          key: entryKey(p.date, p.startTime, p.endTime),
          description: p.description.slice(0, 120),
          state: p.resolution.kind,
          detail: p.resolution.kind === 'linked' ? p.resolution.processo.pasta
            : p.resolution.kind === 'ambiguous' || p.resolution.kind === 'escalate' ? p.resolution.reason
            : p.resolution.kind === 'matter-missing' ? `"${p.resolution.clientName}" is registered, the matter is not`
            : 'firm-internal',
        })),
        note: 'Answer ambiguous / matter-missing / escalate with decisions on log_entries, keyed by `key`.',
      };
    }),
  },
  {
    name: 'log_entries',
    description:
      'Books timesheet lines. Re-plans internally, so pass the same lines you gave plan_entries plus decisions for ' +
      'whatever it would not decide. Never books a span already covered, moves description overflow to observations, ' +
      'and reports held hours. Set dryRun to see the outcome without writing. Pass the configVersion that ' +
      'plan_entries returned: this re-plans internally, so a configuration applied in between would execute a ' +
      'different plan than the one the person approved, with both steps reporting success.',
    schema: {
      lines: z.array(lineArg).min(1),
      decisions: z.record(z.string(), z.object({
        kind: z.enum(['link', 'skip']),
        matterId: z.number().int().positive().optional(),
        contactId: z.number().int().positive().optional(),
        reason: z.string().optional(),
      })).default({}),
      dryRun: z.boolean().default(false),
      configVersion: z.string().optional(),
    },
    run: ({ lines, decisions, dryRun, configVersion: expected }) => guard(async () => {
      const { client, renew } = await context();

      /*
       * A configuration written from a conversation has never been proved against
       * Legal One. `doctor` cannot prove it — it runs with no installed template, so
       * its template checks never fire and an unverified configuration passes clean —
       * and the only real proof writes a probe entry to production, which this
       * surface deliberately does not do. Reading and planning stay open; booking
       * hours under an unproved template would file them under whichever executante
       * and rate the template happens to carry.
       */
      if (configProvisional() && !dryRun) {
        return {
          ok: false,
          error: 'the configuration has not been proved against Legal One yet',
          hint:
            'It was written from a conversation and is marked provisional. Run `bun run setup --write` in the ' +
            'repository: it files one probe entry, reads it back field by field and deletes it. Planning, reading ' +
            'and dryRun work meanwhile.',
        };
      }
      if (expected && expected !== configVersion()) {
        return {
          ok: false,
          error: 'the configuration changed between the plan and this write',
          hint:
            `The plan was made under ${expected} and the configuration in force is ${configVersion()}. Run ` +
            'plan_entries again and show the person the new result — this re-plans internally, so writing now ' +
            'would execute something they did not approve.',
        };
      }
      const planned = await read(() => planEntries(client, lines), renew);
      const mapped: Record<string, Decision> = {};
      for (const [key, d] of Object.entries(decisions as Record<string, any>)) {
        if (d.kind === 'skip') mapped[key] = { kind: 'skip', reason: d.reason ?? 'held by decision' };
        else if (d.matterId) mapped[key] = { kind: 'link', link: { kind: 'processo', id: d.matterId, text: '' } };
        else if (d.contactId) mapped[key] = { kind: 'link', link: { kind: 'contato', id: d.contactId, text: '' } };
      }
      const report = await executePlan(client, planned, { decisions: mapped, dryRun, renew });
      return {
        ok: true, dryRun,
        configVersion: configVersion(),
        written: report.written, alreadyLogged: report.alreadyLogged, held: report.held,
        heldHours: Number((report.heldMinutes / 60).toFixed(2)),
        outcomes: report.outcomes.map((o) => ({ key: o.key, status: o.status, id: o.id, detail: o.detail })),
        report: formatRun(report),
      };
    }),
  },
  {
    name: 'update_entry',
    description: 'Changes fields on an existing entry, preserving everything not named. Reads itself back and raises if the change did not stick, so it is safe to repeat.',
    schema: {
      id: z.number().int().positive(),
      date: dateArg.optional(), startTime: timeArg.optional(), endTime: timeArg.optional(),
      description: z.string().optional(), observations: z.string().optional(),
    },
    run: ({ id, ...changes }) => guard(async () => {
      const { client, renew } = await context();
      const patch = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      await idempotentWrite(() => client.update(id, patch as never), renew);
      return { ok: true, id, changed: Object.keys(patch) };
    }),
  },
  {
    name: 'delete_entry',
    description: 'Permanently deletes one timesheet entry. Legal One offers no undo. Checks the entry exists first and confirms it is gone afterwards, so a wrong id raises instead of silently doing nothing.',
    schema: { id: z.number().int().positive() },
    run: ({ id }) => guard(async () => {
      const { client, renew } = await context();
      await idempotentWrite(() => client.delete(id), renew);
      return { ok: true, id, deleted: true };
    }),
  },
  {
    name: 'set_entry_status',
    description:
      'Moves an entry through approval. Resolves the tenant\'s own id by label rather than trusting a constant. ' +
      'disponivelParaFinanceiro and lancadaNoFinanceiro move work toward invoicing — confirm with the person before either.',
    schema: { id: z.number().int().positive(), status: z.enum(['aprovada', 'disponivelParaAprovacao', 'pendente', 'recusada', 'disponivelParaFinanceiro', 'lancadaNoFinanceiro']) },
    run: ({ id, status }) => guard(async () => {
      const { client, renew } = await context();
      await idempotentWrite(() => client.setEntryStatus(id, status), renew);
      return { ok: true, id, status };
    }),
  },
  {
    name: 'propose_matter',
    description:
      'Prepares a matter for registration. Called without answers it returns the questions a person must settle — ' +
      'never guess these. Called with answers it validates them and returns a confirmationToken for create_matter. ' +
      'Show the proposal to the person before asking for the token: a matter cannot be deleted.',
    schema: {
      contactId: z.number().int().positive(),
      contactName: z.string().min(1),
      cnj: z.string().optional(),
      hints: z.object({ acao: z.string().optional(), orgao: z.string().optional(), shortName: z.string().optional(), titleDescription: z.string().optional() }).default({}),
      answers: z.record(z.string(), z.string()).optional(),
    },
    run: ({ contactId, contactName, cnj, hints, answers }) => guard(async () => {
      const { client, renew } = await context();
      const proposal = await read(
        () => proposeMatter(client, { id: contactId, nome: contactName, documento: null, columns: {} }, cnj ?? null, hints),
        renew,
      );
      const base = {
        ok: true as const,
        derived: proposal.derived,
        suggestedTitle: proposal.suggestedTitle,
        choices: proposal.choices.map((c) => ({ field: c.field, label: c.label, options: c.options, note: c.note, answerWith: [`${c.field}Id`, `${c.field}Text`] })),
        mustAsk: proposal.mustAsk,
      };
      if (!answers) return { ...base, note: 'Settle the choices and mustAsk with a person, then call again with `answers` to get a confirmationToken.' };
      const problems = validateAnswers(proposal, answers);
      if (problems.length > 0) return { ...base, ok: false as const, error: 'answers are incomplete', hint: problems.join('; ') };
      return { ...base, confirmationToken: tokenFor(answers), note: 'Pass these exact answers and this token to create_matter. Changing any answer invalidates it.' };
    }),
  },
  {
    name: 'create_matter',
    description:
      'Registers the matter. Requires the confirmationToken that propose_matter issued for these exact answers — ' +
      'change one and it is refused. Matters cannot be deleted, so this is the one irreversible thing here; do not ' +
      'call it without a person having seen the proposal.',
    schema: {
      contactId: z.number().int().positive(),
      contactName: z.string().min(1),
      cnj: z.string().optional(),
      hints: z.object({ acao: z.string().optional(), orgao: z.string().optional(), shortName: z.string().optional(), titleDescription: z.string().optional() }).default({}),
      answers: z.record(z.string(), z.string()),
      confirmationToken: z.string().min(1),
    },
    run: ({ contactId, contactName, cnj, hints, answers, confirmationToken }) => guard(async () => {
      if (tokenFor(answers) !== confirmationToken) {
        return {
          ok: false, error: 'the confirmation token does not match these answers',
          hint: 'The answers changed since propose_matter issued it. Call propose_matter again with the answers you intend to write, show the person, and use the new token.',
        };
      }
      const { client, renew } = await context();
      const proposal = await read(
        () => proposeMatter(client, { id: contactId, nome: contactName, documento: null, columns: {} }, cnj ?? null, hints),
        renew,
      );
      // Deliberately not wrapped in a renewing write: a matter that landed before an
      // expiry cannot be un-created, and the library verifies by search anyway.
      const id = await createFromProposal(client, proposal, answers);
      return { ok: true, matterId: id, note: 'Registered. This cannot be undone from here.' };
    }),
  },
  {
    name: 'doctor',
    description:
      'Checks that this client\'s assumptions hold on the tenant — grid columns, pagination, date order, status ids, ' +
      'lookup endpoints, form shape, configured ids. Run it when something behaves oddly, and before trusting a ' +
      'configuration. A failure means an assumption broke, and results from other tools may be plausible and wrong. ' +
      'Every check reads real records, so it is slow — around a minute over 30 days, longer over more.',
    schema: { days: z.number().int().min(7).max(365).default(30) },
    run: ({ days }) => guard(async () => {
      const { client } = await context();
      const d = await diagnose(client, { days });
      const body = { checks: d.checks, passed: d.ok, warnings: d.warn, failures: d.fail, report: formatDoctor(d) };
      if (d.fail > 0) {
        return {
          ok: false, ...body,
          error: `${d.fail} assumption(s) this client is built on do not hold on this tenant`,
          hint: 'Do not write until this is understood: results from other tools may be plausible and wrong rather than obviously broken.',
        };
      }
      return { ok: true, ...body };
    }),
  },
];
