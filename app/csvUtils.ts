// Index-based slicing instead of per-char concatenation — the latter is O(n^2)
// and crashes the tab (OOM) on files in the hundreds-of-MB range.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    let field: string;
    if (text[i] === '"') {
      i++;
      let start = i;
      let buf = "";
      while (i < len) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            buf += text.slice(start, i + 1);
            i += 2;
            start = i;
          } else {
            buf += text.slice(start, i);
            i++;
            break;
          }
        } else i++;
      }
      field = buf;
    } else {
      const start = i;
      while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") i++;
      field = text.slice(start, i);
    }
    row.push(field);

    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "\r" || text[i] === "\n") {
      if (text[i] === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

export function csvField(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
