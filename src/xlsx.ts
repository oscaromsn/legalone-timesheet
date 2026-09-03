/*
 * Just enough of the xlsx format to read a report back.
 *
 * An .xlsx is a zip of XML. Reading one needs a zip reader and two parsers, which
 * is a contained amount of code — and a good trade against a dependency, since the
 * whole point of exporting is to hand a manager numbers, and a connector that
 * cannot read its own export is only half useful.
 *
 * Deliberately narrow: it reads the first worksheet of a file this codebase asked
 * Legal One to produce. It is not a spreadsheet library and should not become one.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Extracts a zip's entries.
 *
 * Walks the central directory rather than scanning for local headers: a local
 * header may declare zero sizes and defer them to a trailing data descriptor, so
 * only the central directory is guaranteed to know how long an entry is.
 */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65_557; i--) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error(`corrupt central directory at entry ${n}`);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // The local header repeats the name and extra fields, at its own lengths.
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compressed);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`${name}: unsupported compression method ${method}`);

    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeXml = (s: string): string =>
  s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** `BC` → 54. Cell references carry the column, and sparse rows skip cells. */
const columnOf = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
};

/**
 * Reads the first worksheet as rows of strings.
 *
 * Blank cells are preserved by position: a row that omits a cell leaves a gap, and
 * collapsing that gap would shift every column after it — silently, and only on the
 * rows that happen to have a blank.
 */
export function readSheet(file: Uint8Array): string[][] {
  const files = unzip(file);
  const text = (name: string) => {
    const found = files.get(name);
    return found ? new TextDecoder().decode(found) : '';
  };

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decodeXml(m[1]!.replace(/<[^>]+>/g, '')));

  const sheetName = [...files.keys()].find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) throw new Error('no worksheet in this file');

  const rows: string[][] = [];
  for (const row of text(sheetName).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1]!;
      const at = columnOf(attrs.match(/\br="([A-Z]+)/)?.[1] ?? '');
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      // Inline strings live in <is><t>, everything else in <v>.
      const raw = cell[2]!.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? cell[2]!.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      let value = decodeXml(raw);
      if (type === 's') value = shared[Number(value)] ?? value;
      cells[at >= 0 ? at : cells.length] = value;
    }
    rows.push([...cells].map((c) => c ?? ''));
  }
  return rows;
}

/** The sheet as objects keyed by its header row. */
export function readRecords(file: Uint8Array): Array<Record<string, string>> {
  const rows = readSheet(file);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1)
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}
