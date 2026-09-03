/*
 * The path from a plan to written entries.
 *
 * Until now there wasn't one. `planEntries` produced a classification and printed
 * it; the actual writing lived in per-week scripts that re-decided everything in a
 * hand-written rules array. That array was, in effect, the lawyer's answers to the
 * states the resolver refuses to guess — frozen as TypeScript, which is not a thing
 * a lawyer can write. This takes those answers as data instead.
 *
 * Three rules that were duplicated across those scripts live here now, because each
 * one is a way to lose or corrupt billable time:
 *
 *   Never write an entry that is already there. Duplicates come from retrying
 *   something whose outcome was unclear, and Legal One will happily take both.
 *
 *   Descriptions cap at 500 characters, and the whole form is rejected above that —
 *   with a 200 and a re-rendered page, so it looks like a save. The overflow goes to
 *   `observations`, which has no limit, and nothing is silently discarded.
 *
 *   Held time is counted and reported. An entry that could not be booked is not a
 *   footnote; it is hours that will go unbilled unless someone sees them.
 */
import { DESCRIPTION_MAX, type LegalOneTimesheet, type Link, type TimeEntryRecord } from './client.ts';
import { guardedWrite, type Renew } from './auth.ts';
import type { PlannedEntry } from './resolver.ts';

/**
 * Identifies an entry by when it happened, never by what it says.
 *
 * The grid's description arrives through `stripTags`, which collapses runs of
 * whitespace — so a multi-line description never matches the text that was sent,
 * and the miss reads as "not logged yet". That false negative writes a duplicate,
 * which is the one outcome this file exists to prevent. The times are exact.
 */
export const entryKey = (date: string, startTime: string, endTime: string): string =>
  `${date} ${startTime}-${endTime}`;

const keyOfRecord = (r: TimeEntryRecord): string | null => {
  const start = (r.inicio ?? '').match(/^(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2}:\d{2})$/);
  const end = (r.termino ?? '').match(/(\d{2}:\d{2}:\d{2})$/);
  return start && end ? entryKey(start[1]!, start[2]!, end[1]!) : null;
};

/** What a person decided for an entry the resolver would not decide alone. */
export type Decision =
  | { kind: 'link'; link: Link }
  | { kind: 'skip'; reason: string };

export interface ExecuteOptions {
  /** Answers keyed by `entryKey`, so they survive the plan being regenerated. */
  decisions?: Record<string, Decision>;
  /** Classify and report without writing anything. */
  dryRun?: boolean;
  /** Enables recovery when a session expires mid-batch. */
  renew?: Renew;
}

export type Status = 'written' | 'would-write' | 'already-logged' | 'held';

export interface Outcome {
  key: string;
  description: string;
  minutes: number;
  status: Status;
  id?: number;
  detail: string;
}

export interface ExecutionReport {
  outcomes: Outcome[];
  written: number;
  alreadyLogged: number;
  held: number;
  /** Time that did not get booked. The number someone has to act on. */
  heldMinutes: number;
}

const toMinutes = (t: string): number => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

const sortable = (ddmmyyyy: string): string => ddmmyyyy.split('/').reverse().join('');

/** Runs a plan. Writes only what is decided, never what is merely plausible. */
export async function executePlan(
  client: LegalOneTimesheet,
  planned: PlannedEntry[],
  options: ExecuteOptions = {},
): Promise<ExecutionReport> {
  const outcomes: Outcome[] = [];
  if (planned.length === 0) return { outcomes, written: 0, alreadyLogged: 0, held: 0, heldMinutes: 0 };

  const dates = planned.map((p) => p.date).sort((a, b) => sortable(a).localeCompare(sortable(b)));
  const logged = new Set(
    (await client.listEntries(dates[0]!, dates[dates.length - 1]!))
      .map(keyOfRecord)
      .filter((k): k is string => k !== null),
  );

  /** Folder labels, read once each: a link needs one and a plan repeats matters. */
  const labels = new Map<number, string>();
  const labelFor = async (link: Link): Promise<string> => {
    if (link.text) return link.text;
    if (link.kind !== 'processo') return '';
    const known = labels.get(link.id);
    if (known !== undefined) return known;
    const pasta = (await client.readMatter(link.id))['Pasta'] ?? '';
    if (!pasta) throw new Error(`refusing to link matter ${link.id} with an empty label`);
    labels.set(link.id, pasta);
    return pasta;
  };

  for (const entry of planned) {
    const key = entryKey(entry.date, entry.startTime, entry.endTime);
    const minutes = toMinutes(entry.endTime) - toMinutes(entry.startTime);
    const record = (status: Status, detail: string, id?: number) =>
      outcomes.push({ key, description: entry.description, minutes, status, detail, ...(id ? { id } : {}) });

    if (logged.has(key)) { record('already-logged', 'an entry already covers this span'); continue; }

    const decision = options.decisions?.[key];
    if (decision?.kind === 'skip') { record('held', decision.reason); continue; }

    let link: Link | null = null;
    if (decision?.kind === 'link') link = decision.link;
    else if (entry.resolution.kind === 'linked' || entry.resolution.kind === 'internal') link = entry.resolution.link;

    if (!link) {
      /*
       * ambiguous, matter-missing and escalate all mean the same thing here: the
       * resolver would not choose, and nobody has. Holding is the correct outcome —
       * guessing books hours against the wrong client, and nothing surfaces that.
       */
      const r = entry.resolution;
      const reason =
        r.kind === 'ambiguous' || r.kind === 'escalate' ? r.reason
        : r.kind === 'matter-missing' ? `"${r.clientName}" is registered but the matter is not`
        : 'no link, and no decision was supplied';
      record('held', `${r.kind}: ${reason}`);
      continue;
    }

    const text = await labelFor(link);
    const full = entry.description;
    const overflows = full.length > DESCRIPTION_MAX;
    const payload = {
      date: entry.date,
      startTime: entry.startTime,
      endTime: entry.endTime,
      description: overflows ? `${full.slice(0, DESCRIPTION_MAX - 1)}…` : full,
      ...(overflows ? { observations: full } : {}),
      link: { ...link, text },
    };

    if (options.dryRun) {
      record('would-write', `${link.kind} ${link.id}${text ? ` — ${text}` : ''}${overflows ? ' (overflow to observations)' : ''}`);
      continue;
    }

    /*
     * A create proves nothing on its own, so recovery is a lookup rather than a
     * repeat: after a renewal, ask whether this span is now present. Adopting what
     * landed and only retrying once absence is established is what keeps an
     * interrupted batch from double-booking.
     */
    const check = async () => {
      const same = await client.listEntries(entry.date, entry.date);
      const hit = same.find((r) => keyOfRecord(r) === key);
      return hit ? ({ landed: true, value: hit.id } as const) : ({ landed: false } as const);
    };
    const id = options.renew
      ? await guardedWrite(() => client.create(payload), check, options.renew)
      : await client.create(payload);

    logged.add(key);
    record('written', `${link.kind} ${link.id}${text ? ` — ${text}` : ''}`, id);
  }

  const held = outcomes.filter((o) => o.status === 'held');
  return {
    outcomes,
    written: outcomes.filter((o) => o.status === 'written').length,
    alreadyLogged: outcomes.filter((o) => o.status === 'already-logged').length,
    held: held.length,
    heldMinutes: held.reduce((n, o) => n + o.minutes, 0),
  };
}

const hhmm = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

/** Renders a run. Held time is stated in hours, because that is what goes unbilled. */
export const format = (report: ExecutionReport): string => {
  const lines = report.outcomes.map(
    (o) => `  ${o.status.padEnd(14)} ${o.key.padEnd(30)} ${o.detail.slice(0, 76)}`,
  );
  lines.push(
    '',
    `${report.written} written, ${report.alreadyLogged} already logged, ${report.held} held (${hhmm(report.heldMinutes)})`,
  );
  if (report.held > 0) {
    lines.push('', 'held — these hours are not booked:');
    for (const o of report.outcomes.filter((x) => x.status === 'held')) {
      lines.push(`  ${hhmm(o.minutes).padStart(5)}  ${o.description.slice(0, 60)}`);
      lines.push(`         ${o.detail.slice(0, 90)}`);
    }
  }
  return lines.join('\n');
};
