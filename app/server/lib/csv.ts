/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF line ends, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** CSV rows as objects keyed by the lower-case header names. */
export function csvObjects(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const needsQuotes = /[",\r\n]/;

/** One CSV line. Fields starting with = + - @ are prefixed with ' so spreadsheets do not run them as formulas. */
export function csvLine(fields: Array<string | number | boolean | null | undefined>): string {
  return fields
    .map((f) => {
      let v = f === null || f === undefined ? "" : String(f);
      if (/^[=+\-@]/.test(v)) v = `'${v}`;
      return needsQuotes.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
}
