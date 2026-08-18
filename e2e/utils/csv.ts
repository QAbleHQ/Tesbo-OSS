/*
 * A CSV reader for the export suites.
 *
 * Splitting on commas is not good enough here: the whole point of several export tests is that a
 * title containing a comma, a double quote or a newline survives the round trip, and those values
 * are exactly the ones a naive split mangles. So this is a real RFC 4180 reader — quoted fields,
 * doubled quotes inside them, and CR/LF both inside quotes and as the row separator.
 *
 * Deliberately not a dependency: the product's own writer (LegacyController.rowsToCsv) is 6 lines,
 * and a reader that shares no code with it is what makes the assertions meaningful.
 */

/** Rows of fields, in file order. A trailing newline does not produce an extra empty row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRow();
      // Treat CRLF as one separator, not two.
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    i += 1;
  }
  // A file that ends without a newline still has a final row to flush; one that ends WITH a newline
  // has already flushed it, and must not gain a phantom empty row.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** The header row plus each data row keyed by header, for assertions that read by column name. */
export function parseCsvRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];
  const records = rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
  return { headers, records };
}

/**
 * Builds a CSV upload body, quoting whatever needs it.
 *
 * Mirrors the product's escaping rules so an import fixture can carry the same awkward values the
 * export tests assert on.
 */
export function toCsv(headers: string[], rows: (string | number | undefined)[][]): string {
  const escape = (value: string | number | undefined) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n");
}
