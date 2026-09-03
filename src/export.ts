/*
 * Pulls a firm's timesheet out of Legal One as data.
 *
 * Legal One will produce a real .xlsx of every timesheet entry, which is the one
 * surface here that yields analysis-grade data rather than a rendered page. It does
 * it asynchronously: the request queues a job, the job lands in a shared list of
 * generated reports, and the file is downloaded from there.
 *
 * ## Two things that cost time to learn
 *
 * **This is not a form round-trip.** Everywhere else in this client, writing means
 * read the form, change fields, post it back. Doing that here fails: the browser
 * sends about twenty parameters and the endpoint rejects the eighty-odd a form read
 * produces — silently, by queueing a job that never produces a file. The parameters
 * below are the explicit set, not a form's contents.
 *
 * **The server ignores the date filters.** Asking for March returns every entry
 * there is; measured, by asking for one month and getting all five. So the range is
 * applied here, after parsing, and this file says so rather than passing along a
 * filter that does nothing.
 */
import type { LegalOneTimesheet } from './client.ts';
import { readRecords } from './xlsx.ts';

/** The system report model that exports timesheet entries to Excel. */
const MODEL = 222;
const QUEUE = `/TimeSheet/ReportTimeSheet/ExcelHorasTrabalhadasGerar/${MODEL}`;
const GENERATED = '/TimeSheet/ReportTimeSheet/Search';
const GRID_ROW = /<tr[^>]*class="[^"]*webgrid-(?:row-style|alternating-row)[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;

export interface ExportOptions {
  /** dd/MM/yyyy. Applied locally — the server does not filter. */
  from?: string;
  to?: string;
  /** How long to wait for the queued job. Generation took ~1 min when measured. */
  timeoutMs?: number;
  onProgress?: (note: string) => void;
}

export interface TimesheetExport {
  /** One object per entry, keyed by the sheet's own Portuguese headers. */
  records: Array<Record<string, string>>;
  /** The workbook as downloaded, for handing to a spreadsheet or a notebook. */
  bytes: Uint8Array;
  filename: string;
  /** Rows before the local date filter, so a caller can see what was discarded. */
  totalBeforeFilter: number;
}

const strip = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** dd/MM/yyyy → yyyyMMdd, so dates compare as strings. */
const sortable = (d: string): string => `${d.slice(6, 10)}${d.slice(3, 5)}${d.slice(0, 2)}`;

/**
 * Queues an export, waits for it, and downloads it.
 *
 * The job is tagged with a unique title and found again by that title. Diffing the
 * list would be the obvious alternative and is wrong: the list is shared, other
 * people generate reports into it, and "the newest row" can be someone else's.
 */
export async function exportTimesheet(
  client: LegalOneTimesheet,
  options: ExportOptions = {},
): Promise<TimesheetExport> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const say = options.onProgress ?? (() => {});
  const tag = `timesheet-export-${Date.now().toString(36)}`;

  const query = new URLSearchParams({
    ExportTo: '2',                    // 2 = Excel. The model offers nothing else.
    ReportTitle: tag,
    IsToExecuteSearch: 'True',
    IsTimeSheetContext: 'True',
    SwitchToNewUXApplicationToggle: 'True',
    TipoDtInicio: '0', TipoDtTermino: '0', TipoDtCadastro: '0',
    GroupAbatementHours: 'False', IsGerarCapa: 'False', IsGraphicReport: 'False',
    PageOrientation: '0', ReportModelId: '0', CurrentUserId: '0',
    IsAjax: 'False', RecordCount: '10',
  });

  say(`queueing export as "${tag}"`);
  await client.getText(`${QUEUE}?${query}`);

  const deadline = Date.now() + timeoutMs;
  let href: string | null = null;
  while (Date.now() < deadline && !href) {
    await new Promise((r) => setTimeout(r, 5_000));
    const html = await client.getText(GENERATED);
    for (const row of html.matchAll(GRID_ROW)) {
      if (!strip(row[1]!).includes(tag)) continue;
      href = row[1]!.match(/href="([^"]*GetFile[^"]*)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
      break;
    }
    say(href ? 'ready' : 'still generating…');
  }
  if (!href) {
    throw new Error(
      `the export "${tag}" did not produce a file within ${Math.round(timeoutMs / 1000)}s. ` +
        'It may still be queued — check the generated reports list before requesting another.',
    );
  }

  const { bytes, filename } = await client.getFile(href);
  const all = readRecords(bytes);
  const inRange = all.filter((r) => {
    const date = r['Data início'] ?? '';
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return false;
    if (options.from && sortable(date) < sortable(options.from)) return false;
    if (options.to && sortable(date) > sortable(options.to)) return false;
    return true;
  });
  say(`${all.length} entries exported, ${inRange.length} in range`);
  return { records: inRange, bytes, filename, totalBeforeFilter: all.length };
}

/** Hours, from the sheet's day-fraction duration. `0.125` is three hours. */
export const hoursOf = (record: Record<string, string>, column = 'Duração original'): number => {
  const raw = (record[column] ?? '').replace(',', '.');
  const fraction = Number(raw);
  return Number.isFinite(fraction) ? fraction * 24 : 0;
};
