import XLSX from 'xlsx';

export interface ParsedSheet {
  headers: string[];
  /** One record per data row; every header key present, empty cells as null. */
  rows: Record<string, string | null>[];
}

/**
 * Parses the first sheet of an uploaded workbook.
 *
 * Spike-established options: defval:null keeps empty cells as explicit nulls
 * (SheetJS drops the key entirely by default), raw:false stringifies numeric
 * cells so text and numeric skill/id columns hit one code path. Values arrive
 * verbatim — casing and whitespace included — normalization is ingestion's job.
 */
export function parseMembersWorkbook(buffer: Buffer): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new WorkbookFormatError('workbook has no sheets');
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) {
    throw new WorkbookFormatError('first sheet is empty');
  }

  const grid = XLSX.utils.sheet_to_json<(string | null)[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  const headerRow = grid[0];
  if (!headerRow || headerRow.every((h) => h === null || String(h).trim() === '')) {
    throw new WorkbookFormatError('first row has no headers');
  }
  const headers = headerRow.map((h) => String(h ?? ''));

  const rows = grid.slice(1).map((cells) => {
    const record: Record<string, string | null> = {};
    headers.forEach((header, i) => {
      const value = cells[i];
      record[header] = value === null || value === undefined ? null : String(value);
    });
    return record;
  });

  return { headers, rows };
}

export class WorkbookFormatError extends Error {}
