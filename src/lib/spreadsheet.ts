import { inflateRawSync } from 'node:zlib';

import { ValidationError } from '@/domain/errors';

/**
 * Read the first sheet of an uploaded .xlsx or .csv into rows of text.
 *
 * Cells come back exactly as the file stores them — "1.7592592592592591", not
 * "1.76" — so rounding is a decision the caller makes and shows, never one made
 * here out of sight. An .xlsx keeps the last calculated value of every formula,
 * and that value is what is read; nothing is recalculated.
 *
 * Row i of the result is spreadsheet row i + 1, gaps included, so a problem can
 * be reported as "row 14" and found in Excel on row 14.
 */
export function readSpreadsheet(fileName: string, bytes: Uint8Array): string[][] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(new TextDecoder('utf-8').decode(bytes));
  if (lower.endsWith('.xlsx')) return readXlsx(Buffer.from(bytes));
  throw new ValidationError('Choose a .xlsx or .csv file. Older .xls files: open and "Save As" .xlsx first.');
}

// --- CSV --------------------------------------------------------------------

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new ValidationError('The CSV file has a quote that is never closed.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- XLSX -------------------------------------------------------------------

/** An .xlsx is a zip of XML. A file that unpacks past this is not a price list. */
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

function unzip(buffer: Buffer): Map<string, () => Buffer> {
  // End of central directory: the last record in the file, before any comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable();

  const entries = new Map<string, () => Buffer>();
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw unreadable();
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw unreadable();
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: MAX_UNPACKED_BYTES });
        } catch {
          throw unreadable();
        }
      }
      throw unreadable();
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()] ?? '';
  });
}

/**
 * Every `<tag …>body</tag>` or `<tag …/>` in order, found with indexOf rather
 * than a lazy regex: an unclosed tag in a crafted file would make a regex rescan
 * to the end of the text once per tag, and this runs on an upload.
 */
function* elements(xml: string, tag: string): Generator<{ attributes: string; body: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const next = xml[start + open.length];
    // `<c` must not match `<col` or `<cols`.
    if (next === undefined || !/[\s>/]/.test(next)) {
      at = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) throw unreadable();
    if (xml[tagEnd - 1] === '/') {
      yield { attributes: xml.slice(start + open.length, tagEnd - 1), body: '' };
      at = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd);
    if (end < 0) throw unreadable();
    yield { attributes: xml.slice(start + open.length, tagEnd), body: xml.slice(tagEnd + 1, end) };
    at = end + close.length;
  }
}

const unreadable = () => new ValidationError('That file is not a readable .xlsx workbook.');

/** The text of every <t> run, ignoring phonetic guides (<rPh>), as Excel shows it. */
function runText(xml: string): string {
  let shown = '';
  let at = 0;
  for (let start = xml.indexOf('<rPh', at); start >= 0; start = xml.indexOf('<rPh', at)) {
    const end = xml.indexOf('</rPh>', start);
    if (end < 0) throw unreadable();
    shown += xml.slice(at, start);
    at = end + '</rPh>'.length;
  }
  shown += xml.slice(at);
  let text = '';
  for (const run of elements(shown, 't')) text += decodeXml(run.body);
  return text;
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** "AB12" → column index 27 (zero-based) and row 12. */
function cellPosition(ref: string): { column: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) };
}

function readXlsx(buffer: Buffer): string[][] {
  const files = unzip(buffer);
  const read = (name: string) => files.get(name)?.().toString('utf8');

  // The first tab is the first <sheet> in the workbook, wherever its file lives.
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw unreadable();
  const firstSheet = elements(workbook, 'sheet').next().value;
  const relId = firstSheet ? attribute(firstSheet.attributes, 'r:id') : undefined;
  const rel = relId
    ? Array.from(elements(rels, 'Relationship')).find((item) => attribute(item.attributes, 'Id') === relId)
    : undefined;
  const target = rel ? attribute(rel.attributes, 'Target') : undefined;
  if (!target) throw new ValidationError('The workbook has no sheets.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = read(sheetPath);
  if (!sheet) throw new ValidationError('The workbook has no sheets.');

  const sharedXml = read('xl/sharedStrings.xml') ?? '';
  const shared = Array.from(elements(sharedXml, 'si'), (item) => runText(item.body));

  const rows: string[][] = [];
  for (const { attributes, body } of elements(sheet, 'c')) {
    const position = cellPosition(attribute(attributes, 'r') ?? '');
    if (!position) continue;
    const type = attribute(attributes, 't');
    const value = decodeXml(elements(body, 'v').next().value?.body ?? '');
    let text: string;
    if (type === 's') text = shared[Number(value)] ?? '';
    else if (type === 'inlineStr') text = runText(body);
    else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
    else if (type === 'e') text = '';
    else text = value;
    // Formatted but empty cells (<c r="B6000" s="3"/>) are not data; skipping
    // them keeps a sheet styled down to row 6000 the length of its real rows.
    if (text.trim() === '') continue;

    const row = (rows[position.row - 1] ??= []);
    row[position.column] = text;
  }
  // Fill the holes a sparse sheet leaves, so every row is a plain array of text.
  return Array.from(rows, (row) => Array.from(row ?? [], (cell) => cell ?? ''));
}
