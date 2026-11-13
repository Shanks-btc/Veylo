// A small PDF writer (slice W5, D4): A4 pages of plain text in the built-in Helvetica fonts, with
// clickable links. No library, no font file, no network: it runs in the browser and in tests. Text
// is written uncompressed, so a reader (or a test) can find any word in the file's bytes.
// Helvetica's built-in encoding is Latin-1: other characters are replaced with "?".

export type PdfLine = {
  text: string;
  /** Points; default 10. */
  size?: number;
  bold?: boolean;
  /** Makes the line a link to this URL (it's also printed, so a paper copy still has it). */
  link?: string;
  /** Blank space above the line, in points. */
  gap?: number;
};

const PAGE = { w: 595, h: 842, margin: 56 };
/** A page coordinate rounded to two decimals. These are positions on a page, never money. */
const pdfNum = (n: number): string => String(Math.round(n * 100) / 100);

const latin1 = (s: string) =>
  [...s].map((c) => (c.charCodeAt(0) < 256 && c >= " " ? c : "?")).join("");
const escapeText = (s: string) => latin1(s).replace(/[\\()]/g, (c) => `\\${c}`);

/** Wraps on spaces to at most `max` characters; a word longer than that (a URL) stays whole. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") out.push(line);
  return out.length > 0 ? out : [""];
}

export function renderPdf(title: string, lines: readonly PdfLine[]): Uint8Array {
  // Lay out into pages first.
  type Placed = PdfLine & { y: number };
  const pages: Placed[][] = [[]];
  let y = PAGE.h - PAGE.margin;
  for (const l of lines) {
    const size = l.size ?? 10;
    y -= (l.gap ?? 0) + size * 1.4;
    if (y < PAGE.margin) {
      pages.push([]);
      y = PAGE.h - PAGE.margin - size * 1.4;
    }
    (pages[pages.length - 1] as Placed[]).push({ ...l, y });
  }

  // Objects: 1 catalog, 2 page tree, 3 and 4 the fonts, then per page its page, content, links.
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES"); // Filled in below, once the page object numbers are known.
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    const content = page
      .map((l) => {
        const size = l.size ?? 10;
        return `BT /${l.bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin} ${pdfNum(l.y)} Td (${escapeText(l.text)}) Tj ET`;
      })
      .join("\n");
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const annots = page
      .filter((l) => l.link !== undefined)
      .map((l) => {
        const size = l.size ?? 10;
        const width = latin1(l.text).length * size * 0.52;
        return add(
          `<< /Type /Annot /Subtype /Link /Rect [${PAGE.margin} ${pdfNum(l.y - 2)} ${pdfNum(PAGE.margin + width)} ${pdfNum(l.y + size)}] /Border [0 0 0] /A << /S /URI /URI (${escapeText(l.link as string)}) >> >>`,
        );
      });
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R${annots.length > 0 ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Title (${escapeText(title)}) /Producer (Veylo) >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is ASCII or Latin-1, so one byte each.
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** The text of a PDF made by renderPdf (it's stored uncompressed), for tests and previews. */
export function pdfText(bytes: Uint8Array): string {
  const s = String.fromCharCode(...bytes);
  return [...s.matchAll(/\(((?:[^\\()]|\\.)*)\) Tj/g)]
    .map((m) => (m[1] as string).replace(/\\(.)/g, "$1"))
    .join("\n");
}
