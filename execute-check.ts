/*
 * Asserts that running a plan never books the same hour twice.
 *
 * This is the most consequential invariant in the codebase. Legal One accepts a
 * duplicate without complaint, nothing downstream notices, and the result is a
 * client billed twice for one hour of work. Every case here is a way that has
 * nearly happened.
 *
 * Offline: the client is a stub, so this needs no fixtures, no session and no
 * network. Add a case whenever executePlan learns a new way to decide.
 */
import { executePlan, entryKey } from './src/execute.ts';
import { SessionExpiredError } from './src/client.ts';
import type { PlannedEntry } from './src/resolver.ts';

const LINK = { kind: 'contato' as const, id: 3, text: 'Example firm' };
const internal = (date: string, from: string, to: string, description: string): PlannedEntry => ({
  date, startTime: from, endTime: to, description, resolution: { kind: 'internal', link: LINK },
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const stub = (existing: Array<Record<string, unknown>> = []) => {
  const created: Array<Record<string, unknown>> = [];
  const client = {
    listEntries: async () => existing,
    create: async (e: Record<string, unknown>) => { created.push(e); return 100 + created.length; },
    readMatter: async () => ({ Pasta: 'Proc - 0001234' }),
  };
  return { client: client as never, created };
};

{
  const { client, created } = stub();
  const report = await executePlan(client, [internal('01/09/2026', '09:00:00', '10:00:00', 'A')], { dryRun: true });
  check('dry run writes nothing', created.length === 0 && report.outcomes[0]!.status === 'would-write');
}

{
  /*
   * The grid renders descriptions through stripTags, which collapses whitespace, so
   * a multi-line entry never matches the text that was sent. Keying on the text
   * would read as "not logged yet" and write it again.
   */
  const { client, created } = stub([
    { id: 9, inicio: '01/09/2026 09:00:00', termino: '01/09/2026 10:00:00', descricao: 'multi  line   description' },
  ]);
  const report = await executePlan(client, [internal('01/09/2026', '09:00:00', '10:00:00', 'multi\nline\ndescription')]);
  check('does not rewrite an entry whose description merely renders differently',
    created.length === 0 && report.alreadyLogged === 1, `created=${created.length}`);
}

{
  const { client, created } = stub();
  const long = 'x'.repeat(700);
  await executePlan(client, [internal('01/09/2026', '09:00:00', '10:00:00', long)]);
  const sent = created[0] as { description: string; observations?: string };
  check('overflow is moved to observations, never truncated away',
    sent.description.length === 500 && sent.description.endsWith('…') && sent.observations === long,
    `len=${sent.description.length}`);
}

{
  const { client, created } = stub();
  const planned: PlannedEntry[] = [
    { date: '01/09/2026', startTime: '10:00:00', endTime: '11:30:00', description: 'unresolved',
      resolution: { kind: 'escalate', reason: 'client is not registered', clientName: 'Acme' } },
  ];
  const report = await executePlan(client, planned);
  check('an entry nobody decided is held, with its hours counted',
    created.length === 0 && report.held === 1 && report.heldMinutes === 90, `held=${report.heldMinutes}min`);
}

{
  const { client, created } = stub();
  const planned: PlannedEntry[] = [
    { date: '01/09/2026', startTime: '09:00:00', endTime: '10:00:00', description: 'ambiguous one',
      resolution: { kind: 'ambiguous', candidates: [], reason: 'two matters match' } },
  ];
  const key = entryKey('01/09/2026', '09:00:00', '10:00:00');
  const report = await executePlan(client, planned, {
    decisions: { [key]: { kind: 'link', link: { kind: 'processo', id: 77, text: '' } } },
  });
  const sent = created[0] as { link: { id: number; text: string } };
  check('a human decision resolves what the resolver would not, and the label is read back',
    report.written === 1 && sent.link.id === 77 && sent.link.text === 'Proc - 0001234');
}

{
  const { client, created } = stub();
  const key = entryKey('01/09/2026', '09:00:00', '10:00:00');
  const report = await executePlan(client, [internal('01/09/2026', '09:00:00', '10:00:00', 'A')], {
    decisions: { [key]: { kind: 'skip', reason: 'the lawyer wants to check this one' } },
  });
  check('an explicit skip holds an entry the resolver would have written',
    created.length === 0 && report.held === 1 && report.outcomes[0]!.detail.includes('check this one'));
}

{
  /*
   * The dangerous one. A create is accepted, the session expires before the
   * response is read, and the entry exists. Retrying blindly bills it twice.
   */
  let attempts = 0;
  const existing: Array<Record<string, unknown>> = [];
  const client = {
    listEntries: async () => existing,
    create: async () => {
      attempts++;
      existing.push({ id: 55, inicio: '01/09/2026 09:00:00', termino: '01/09/2026 10:00:00', descricao: 'A' });
      throw new SessionExpiredError('create');
    },
    readMatter: async () => ({ Pasta: 'P' }),
  } as never;

  const report = await executePlan(client, [internal('01/09/2026', '09:00:00', '10:00:00', 'A')], {
    renew: async () => {},
  });
  check('a create interrupted after it landed is adopted, not repeated',
    attempts === 1 && report.written === 1 && report.outcomes[0]!.id === 55, `attempts=${attempts}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
