/** Builds a tab-separated block that pastes into Excel/Sheets as columns, not one blob. */
export function toTsv(headers: string[], rows: Array<Array<string | number>>): string {
  const escape = (value: string | number) => String(value).replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ");
  return [headers, ...rows].map((row) => row.map(escape).join("\t")).join("\n");
}
