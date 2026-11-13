/**
 * TrusMeet: signed minutes as a PDF, made in the browser (no library, nothing uploaded).
 * Uses the PDF standard fonts, so text is limited to Western European characters;
 * anything else is shown as "?" and the caller is told.
 */
(function () {
  const PAGE_W = 595; // A4 in points
  const PAGE_H = 842;
  const MARGIN = 56;
  const TEXT_W = PAGE_W - 2 * MARGIN;

  // Helvetica widths (per 1000 units) for characters 32..126.
  const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

  // Characters outside Latin-1 that the WinAnsi encoding still has.
  const WIN_ANSI = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
    '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
    '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };

  // Text -> single-byte string in WinAnsi. Counts what could not be shown.
  function toWinAnsi(text, stats) {
    let out = '';
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      if (ch === '\n') out += '\n';
      else if (ch === '\r') continue;
      else if (ch === '\t') out += '    ';
      else if (/[\u2000-\u200a\u202f\u205f\u3000]/.test(ch)) out += ' ';
      else if (/[\u200b-\u200d\ufeff]/.test(ch)) continue;
      else if (code >= 32 && code <= 126) out += ch;
      else if (code >= 160 && code <= 255) out += String.fromCharCode(code);
      else if (WIN_ANSI[ch]) out += String.fromCharCode(WIN_ANSI[ch]);
      else { out += '?'; stats.replaced += 1; }
    }
    return out;
  }

  // Helvetica-Bold widths for characters 32..126.
  const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

  function charWidth(c, font) {
    if (font === 'mono') return 600;
    const code = c.charCodeAt(0);
    const table = font === 'bold' ? HELV_BOLD : HELV;
    return code >= 32 && code <= 126 ? table[code - 32] : (font === 'bold' ? 611 : 556);
  }

  function textWidth(s, font, size) {
    let w = 0;
    for (const c of s) w += charWidth(c, font);
    return (w * size) / 1000;
  }

  // Word wrap; words longer than a line (hashes, signatures) are split.
  function wrap(s, font, size, width) {
    const lines = [];
    for (const para of s.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        if (textWidth(line + word, font, size) <= width) { line += word; continue; }
        if (line.trim()) lines.push(line.replace(/\s+$/, ''));
        line = '';
        let rest = word.replace(/^\s+/, '');
        while (rest && textWidth(rest, font, size) > width) {
          let n = 1;
          while (n < rest.length && textWidth(rest.slice(0, n + 1), font, size) <= width) n += 1;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }

  const pdfString = (s) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
  const FONT_KEYS = { regular: 'F1', bold: 'F2', mono: 'F3' };

  class Layout {
    constructor(stats, bottom = MARGIN + 30) {
      this.stats = stats;
      this.bottom = bottom; // where the page footer begins
      this.pages = [];
      this.newPage();
    }
    newPage() {
      this.ops = [];
      this.pages.push(this.ops);
      this.y = PAGE_H - MARGIN;
    }
    space(h) {
      this.y -= h;
      if (this.y < this.bottom) this.newPage();
    }
    // Adds wrapped text: { font, size, color: [r,g,b], indent }
    text(raw, { font = 'regular', size = 11, color = [0.1, 0.1, 0.1], indent = 0, gap = 1.35 } = {}) {
      const s = toWinAnsi(raw, this.stats);
      for (const line of wrap(s, font, size, TEXT_W - indent)) {
        if (this.y - size < this.bottom) this.newPage();
        this.y -= size * gap;
        this.ops.push(`${color.join(' ')} rg BT /${FONT_KEYS[font]} ${size} Tf ${MARGIN + indent} ${this.y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
      }
    }
    rule() {
      this.space(8);
      this.ops.push(`0.75 0.78 0.85 RG 0.8 w ${MARGIN} ${this.y.toFixed(2)} m ${PAGE_W - MARGIN} ${this.y.toFixed(2)} l S`);
      this.space(6);
    }
    centered(raw, { font = 'bold', size = 16, color = [0.1, 0.1, 0.1], underline = false } = {}) {
      const s = toWinAnsi(raw, this.stats);
      if (this.y - size < this.bottom) this.newPage();
      this.y -= size * 1.35;
      const w = textWidth(s, font, size);
      const x = MARGIN + Math.max(0, (TEXT_W - w) / 2);
      this.ops.push(`${color.join(' ')} rg BT /${FONT_KEYS[font]} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
      const lineW = w;
      if (underline) this.ops.push(`${color.join(' ')} RG 0.7 w ${x.toFixed(2)} ${(this.y - 2).toFixed(2)} m ${(x + lineW).toFixed(2)} ${(this.y - 2).toFixed(2)} l S`);
    }
    heading(raw) {
      if (this.y < this.bottom + 60) this.newPage(); // keep a heading with its first lines
      this.space(10);
      this.text(raw, { font: 'bold', size: 12, color: [0.12, 0.16, 0.42] });
      this.space(3);
      this.ops.push(`0.12 0.16 0.42 RG 0.6 w ${MARGIN} ${this.y.toFixed(2)} m ${PAGE_W - MARGIN} ${this.y.toFixed(2)} l S`);
      this.space(4);
    }
    // One table row. cells: [{ text, w, font }]; widths add up to the line width.
    row(cells, { size = 10, pad = 0, border = false, fill = null, repeatHeader = null } = {}) {
      const lineH = size * 1.35;
      const prepared = cells.map((c) => {
        const font = c.font || 'regular';
        return { ...c, font, lines: wrap(toWinAnsi(c.text, this.stats), font, size, c.w - 2 * pad - (border ? 4 : 0)) };
      });
      const h = Math.max(...prepared.map((c) => c.lines.length)) * lineH + 2 * pad + (border ? 4 : 0);
      if (this.y - h < this.bottom) {
        this.newPage();
        if (repeatHeader) repeatHeader();
      }
      const top = this.y;
      let x = MARGIN;
      prepared.forEach((c) => {
        if (fill) this.ops.push(`${fill.join(' ')} rg ${x.toFixed(2)} ${(top - h).toFixed(2)} ${c.w.toFixed(2)} ${h.toFixed(2)} re f`);
        if (border) this.ops.push(`0.7 0.72 0.78 RG 0.6 w ${x.toFixed(2)} ${(top - h).toFixed(2)} ${c.w.toFixed(2)} ${h.toFixed(2)} re S`);
        c.lines.forEach((line, i) => {
          const ty = top - pad - (border ? 2 : 0) - (i + 1) * lineH + size * 0.3;
          const tx = c.align === 'right' ? x + c.w - pad - textWidth(line, c.font, size)
            : (c.align === 'center' ? x + (c.w - textWidth(line, c.font, size)) / 2 : x + pad + (border ? 2 : 0));
          this.ops.push(`${(c.color || [0.1, 0.1, 0.1]).join(' ')} rg BT /${FONT_KEYS[c.font]} ${size} Tf ${tx.toFixed(2)} ${ty.toFixed(2)} Td ${pdfString(line)} Tj ET`);
        });
        x += c.w;
      });
      this.y = top - h;
    }
  }

  // Finds a person's decision by display name or username, ignoring case.
  // "Dr. A Saha, Professor" is looked up as "Dr. A Saha".
  function approvalFinder(approvals) {
    const byName = new Map();
    approvals.forEach((a) => {
      [a.name, a.userId, a.sig && a.sig.signer, a.sig && a.sig.signed_by].filter(Boolean)
        .forEach((k) => { const key = String(k).trim().toLowerCase(); if (!byName.has(key) || a.sig) byName.set(key, a); });
    });
    return (name) => byName.get(String(name || '').split(',')[0].trim().toLowerCase());
  }

  // In official minutes the Chairperson's approval makes them final.
  function chairStatus(minutesText, approvals) {
    const m = /^Approved by: (.*) \(Chairperson\)$/m.exec(minutesText);
    if (!m || /^Not recorded$/.test(m[1])) return null;
    const a = approvalFinder(approvals)(m[1]);
    if (a && a.sig) return a.decision === 'approved' ? 'approved' : 'not approved';
    return 'pending';
  }

  // Lays out minutes in the Indian official format (see minutes-doc.js).
  // approvals: [{ name, decision, sig, id, when }] for the signature block.
  function layoutIndianMinutes(doc, text, approvals, logo) {
    const lines = text.split('\n');
    const approvalOf = approvalFinder(approvals);
    const approvalNote = (name) => {
      const a = approvalOf(name);
      if (!a || !a.sig) return 'Approval pending';
      return `${a.decision === 'approved' ? 'Digitally approved' : 'Did not approve'} ${a.when} [${a.id}]`;
    };
    // "Sd/-" (signed) only above someone who actually approved.
    const sd = (name) => { const a = approvalOf(name); return a && a.sig && a.decision === 'approved' ? 'Sd/-\n' : '\n'; };

    let i = 0;
    const heads = [];
    let ref = '';
    let dated = '';
    for (; i < lines.length && lines[i] !== 'MINUTES OF THE MEETING'; i++) {
      if (lines[i].startsWith('No.: ')) ref = lines[i];
      else if (lines[i].startsWith('Dated: ')) dated = lines[i];
      else if (lines[i].trim()) heads.push(lines[i]);
    }
    // Letterhead: the lab logo on the left, organisation and department centred.
    const LOGO = 58;
    const top = doc.y;
    if (logo) doc.ops.push(`q ${LOGO} 0 0 ${LOGO} ${MARGIN} ${(top - LOGO).toFixed(2)} cm /Im1 Do Q`);
    if (logo && heads.length) doc.space(Math.max(0, (LOGO - (heads.length === 1 ? 19 : 34)) / 2));
    heads.forEach((h, k) => doc.centered(h, { size: k === 0 ? 14 : 11 }));
    if (logo) doc.y = Math.min(doc.y, top - LOGO);
    doc.space(logo ? 6 : 0);
    doc.ops.push(`0.6 0.6 0.6 RG 0.8 w ${MARGIN} ${(doc.y - 2).toFixed(2)} m ${PAGE_W - MARGIN} ${(doc.y - 2).toFixed(2)} l S`);
    doc.space(8);
    doc.row([{ text: ref, w: TEXT_W * 0.6 }, { text: dated, w: TEXT_W * 0.4, align: 'right' }], { size: 10 });
    doc.space(10);
    doc.centered('MINUTES OF THE MEETING', { size: 13, underline: true });
    doc.space(10);
    i += 1;

    const SECTION = /^(\d+)\. ([A-Z][A-Z /-]+)$/;
    const PARA = /^(\d+)\. (.+)$/;
    const ITEM = /^(\d+\.\d+) (.*)$/;
    const ACTION = /^(\d+\.\d+) (.*) \| Action by: (.*) \| Timeline: (.*)$/;
    const widths = [44, 255, 110, TEXT_W - 409];
    const actionHeader = () => doc.row(['S. No.', 'Action Point', 'Action by', 'Timeline']
      .map((t, k) => ({ text: t, w: widths[k], font: 'bold' })), { size: 10, pad: 3, border: true, fill: [0.93, 0.93, 0.93] });
    let actions = [];
    const flush = () => {
      if (!actions.length) return;
      actionHeader();
      actions.forEach((m) => doc.row([m[1], m[2], m[3], m[4]].map((t, k) => ({ text: t, w: widths[k] })),
        { size: 10, pad: 3, border: true, repeatHeader: actionHeader }));
      actions = [];
      doc.space(4);
    };
    const signature = [];
    const parseSigner = (l) => {
      const body = l.slice(l.indexOf(': ') + 2);
      const role = (/\(([^)]*)\)$/.exec(body) || [])[1] || '';
      const who = body.replace(/\s*\([^)]*\)$/, '');
      return { who, role, note: approvalNote(who) };
    };

    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('ANNEXURE-I:')) break;
      const action = ACTION.exec(line);
      if (action) { actions.push(action); continue; }
      flush();
      if (line.startsWith('Subject: ')) {
        doc.row([{ text: 'Subject:', w: 56, font: 'bold' }, { text: line.slice(9), w: TEXT_W - 56, font: 'bold' }], { size: 11 });
        doc.space(6);
      } else if (line.startsWith('Minutes recorded by: ') || line.startsWith('Approved by: ')) {
        signature.push(parseSigner(line));
        if (signature.length === 2) {
          // Signature block: Member Secretary / Convener on the left, Chairperson on the right.
          const [left, right] = signature;
          doc.space(18);
          doc.row([
            { text: `${sd(left.who)}${left.who}\n${left.role}`, w: TEXT_W / 2, font: 'bold' },
            { text: `${sd(right.who)}${right.who}\n${right.role}`, w: TEXT_W / 2, font: 'bold', align: 'right' }
          ], { size: 10 });
          doc.row([
            { text: left.note, w: TEXT_W / 2, color: [0.35, 0.35, 0.4] },
            { text: right.note, w: TEXT_W / 2, align: 'right', color: [0.35, 0.35, 0.4] }
          ], { size: 8 });
          doc.space(12);
        }
      } else if (line.startsWith('To: ') || line.startsWith('Copy to: ')) {
        const k = line.indexOf(': ');
        doc.row([{ text: line.slice(0, k + 1), w: 56, font: 'bold' }, { text: line.slice(k + 2), w: TEXT_W - 56 }], { size: 10 });
      } else if (SECTION.test(line)) {
        const m = SECTION.exec(line);
        doc.space(6);
        doc.row([{ text: `${m[1]}.`, w: 22, font: 'bold' }, { text: m[2], w: TEXT_W - 22, font: 'bold' }], { size: 11 });
        doc.space(2);
      } else if (ITEM.test(line)) {
        const m = ITEM.exec(line);
        doc.row([{ text: '', w: 22 }, { text: m[1], w: 30 }, { text: m[2], w: TEXT_W - 52 }], { size: 11, pad: 1 });
      } else if (PARA.test(line)) {
        const m = PARA.exec(line);
        doc.space(4);
        doc.row([{ text: `${m[1]}.`, w: 22 }, { text: m[2], w: TEXT_W - 22 }], { size: 11 });
      } else if (line.trim()) {
        doc.row([{ text: '', w: 22 }, { text: line, w: TEXT_W - 22 }], { size: 11 });
      }
    }
    flush();

    // Annexure-I starts on its own page, as annexures do.
    doc.newPage();
    doc.centered(lines[i] || 'ANNEXURE-I: LIST OF PARTICIPANTS', { size: 12, underline: true });
    doc.space(8);
    const pw = [50, TEXT_W - 50];
    doc.row([{ text: 'S. No.', w: pw[0], font: 'bold' }, { text: 'Name', w: pw[1], font: 'bold' }], { size: 10, pad: 3, border: true, fill: [0.93, 0.93, 0.93] });
    for (i += 1; i < lines.length; i++) {
      const m = /^(\d+)\) (.*)$/.exec(lines[i]);
      if (m) doc.row([{ text: m[1], w: pw[0] }, { text: m[2], w: pw[1] }], { size: 10, pad: 3, border: true });
      else if (lines[i].trim()) { doc.space(6); doc.text(lines[i], { size: 10 }); }
    }
  }

  const SECTION_RE = /^(\d+)\. ([A-Z][A-Z /]+)$/;
  const ACTION_RE = /^(\d+\.\d+) (.*) \| Owner: (.*) \| Due: (.*)$/;
  const ITEM_RE = /^(\d+\.\d+) (.*)$/;

  // Lays out minutes written in the standard format (see minutes-doc.js).
  function layoutStandardMinutes(doc, text) {
    const lines = text.split('\n');
    doc.centered(lines[0], { size: 18, color: [0.12, 0.16, 0.42] });
    doc.space(10);
    let i = 1;
    while (i < lines.length && !SECTION_RE.test(lines[i])) {
      const line = lines[i];
      const colon = line.indexOf(': ');
      if (colon > 0) {
        doc.row([{ text: line.slice(0, colon), w: 140, font: 'bold' }, { text: line.slice(colon + 2), w: TEXT_W - 140 }], { size: 10, pad: 2 });
      } else if (line.trim()) {
        doc.text(line, { size: 10 });
      }
      i += 1;
    }

    let section = '';
    let actionRows = [];
    const actionWidths = [40, 243, 110, TEXT_W - 393];
    const actionHeader = () => doc.row([
      { text: 'No.', w: actionWidths[0], font: 'bold' }, { text: 'Action', w: actionWidths[1], font: 'bold' },
      { text: 'Owner', w: actionWidths[2], font: 'bold' }, { text: 'Due', w: actionWidths[3], font: 'bold' }
    ], { size: 10, pad: 3, border: true, fill: [0.92, 0.93, 0.97] });
    const flushActions = () => {
      if (!actionRows.length) return;
      actionHeader();
      actionRows.forEach((m) => doc.row([
        { text: m[1], w: actionWidths[0] }, { text: m[2], w: actionWidths[1] },
        { text: m[3], w: actionWidths[2] }, { text: m[4], w: actionWidths[3] }
      ], { size: 10, pad: 3, border: true, repeatHeader: actionHeader }));
      actionRows = [];
    };

    for (; i < lines.length; i++) {
      const line = lines[i];
      const sec = SECTION_RE.exec(line);
      if (sec) {
        flushActions();
        section = sec[2];
        doc.heading(line);
        continue;
      }
      const action = section === 'ACTION ITEMS' && ACTION_RE.exec(line);
      if (action) { actionRows.push(action); continue; }
      flushActions();
      const item = ITEM_RE.exec(line);
      if (item) {
        doc.row([{ text: item[1], w: 32 }, { text: item[2], w: TEXT_W - 32 }], { size: 11, pad: 1 });
      } else if (line.trim()) {
        doc.text(line, { size: 11 });
      } else {
        doc.space(2);
      }
    }
    flushActions();
  }

  // Width and height from a baseline or progressive JPEG.
  function jpegSize(bytes) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
      }
      i += 2 + len;
    }
    return null;
  }

  // logo (optional): { bytes: Uint8Array of a JPEG }, drawn as /Im1 on any page that uses it.
  function buildPdf(pages, footerOps, logo) {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    let image = null;
    const size = logo && jpegSize(logo.bytes);
    if (size) {
      let data = '';
      for (let k = 0; k < logo.bytes.length; k += 8192) data += String.fromCharCode(...logo.bytes.subarray(k, k + 8192));
      const space = size.components === 1 ? '/DeviceGray' : (size.components === 4 ? '/DeviceCMYK' : '/DeviceRGB');
      image = add(`<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace ${space} `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n${data}\nendstream`);
    }
    const pageIds = [];
    pages.forEach((ops, i) => {
      const footer = footerOps(i, pages.length);
      const stream = `${ops.join('\n')}\n${footer}`;
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
        + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >> /Contents ${content} 0 R >>`));
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { out += `${String(o).padStart(10, '0')} 00000 n \n`; });
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "13 Nov 2026, 01:33 IST" in this computer's time zone.
  function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const tz = (Intl.DateTimeFormat('en-IN', { timeZoneName: 'short' }).formatToParts(d)
      .find((p) => p.type === 'timeZoneName') || {}).value || '';
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}${tz ? ` ${tz}` : ''}`;
  }

  // Short reference to one signature, e.g. "3F9A-21C4" (first 8 hex digits of its SHA-256).
  async function signatureId(signatureB64) {
    const hex = (await sha256Hex(String(signatureB64 || ''))) || String(signatureB64 || '').replace(/[^0-9a-f]/gi, '').padEnd(8, '0');
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`.toUpperCase();
  }

  // Footer on every page: everyone who signed, then the minutes digest and page number.
  function footerFor(entryTexts, digest, stats, result) {
    const size = 7;
    const lineH = size * 1.3;
    // Each signer's entry stays on one line; entries are packed into as few lines as fit.
    const entries = entryTexts.map((t) => toWinAnsi(t, stats));
    const signedLines = [];
    let current = 'Approval: ';
    entries.forEach((entry, k) => {
      const piece = (k ? '   |   ' : '') + entry;
      if (k && textWidth(current + piece, 'regular', size) > TEXT_W) {
        signedLines.push(`${current}   |`);
        current = entry;
      } else {
        current += piece;
      }
    });
    signedLines.push(current);
    // A single entry wider than the page still wraps.
    for (let k = signedLines.length - 1; k >= 0; k--) {
      if (textWidth(signedLines[k], 'regular', size) > TEXT_W) signedLines.splice(k, 1, ...wrap(signedLines[k], 'regular', size, TEXT_W));
    }
    // The result line wraps so it never runs into "Page x of y" on the right.
    const pageRoom = textWidth('Page 99 of 99', 'regular', size) + 12;
    const infoLines = wrap(toWinAnsi(`Result: ${result} | Minutes SHA-256 ${digest.slice(0, 12)}...`, stats), 'regular', size, TEXT_W - pageRoom);
    const lines = signedLines.length + infoLines.length;
    const top = 26 + lines * lineH + 6; // the footer sits between y=26 and this line
    return {
      height: top + 14,
      ops: (index, total) => {
        const out = [`0.75 0.78 0.85 RG 0.6 w ${MARGIN} ${top.toFixed(2)} m ${PAGE_W - MARGIN} ${top.toFixed(2)} l S`];
        let y = top - lineH;
        signedLines.forEach((line) => {
          out.push(`0.2 0.22 0.3 rg BT /F1 ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
          y -= lineH;
        });
        const page = `Page ${index + 1} of ${total}`;
        out.push(`0.45 0.45 0.5 rg BT /F1 ${size} Tf ${(PAGE_W - MARGIN - textWidth(page, 'regular', size)).toFixed(2)} ${y.toFixed(2)} Td ${pdfString(page)} Tj ET`);
        infoLines.forEach((line) => {
          out.push(`0.45 0.45 0.5 rg BT /F1 ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
          y -= lineH;
        });
        return out.join('\n');
      }
    };
  }

  async function sha256Hex(text) {
    if (!(window.crypto && crypto.subtle)) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * meeting: { name, id }; minutesText: the exact signed text;
   * signatures: receipts that signed this text; assuranceLabel(a) -> string.
   * Returns { blob, fileName, replaced, hashChecked }. Throws if the text doesn't match the signature.
   */
  const DECISION_TEXT = { approved: 'Approved', not_approved: 'Not approved', no_response: 'No response' };

  /**
   * approvals (optional): [{ name, decision: approved | not_approved | no_response, reason, sig }]
   * for everyone who attended. Without it, every signature counts as an approval.
   */
  async function makeSignedMinutesPdf({ meeting, minutesText, signatures, approvals, assuranceLabel, logo }) {
    const digest = signatures[0].document_sha256;
    const actual = await sha256Hex(minutesText);
    if (actual && actual !== digest) {
      throw new Error('These minutes do not match the signed version, so no PDF was made.');
    }

    const stats = { replaced: 0 };
    const rows = await Promise.all((approvals || signatures.map((sig) => ({ name: sig.signed_by, decision: 'approved', reason: '', sig })))
      .map(async (r) => ({
        ...r,
        id: r.sig ? await signatureId(r.sig.signature_b64) : '',
        when: r.sig ? formatWhen(r.sig.timestamp) : '',
        status: r.sig ? assuranceLabel(r.sig.assurance) : ''
      })));
    const approvedCount = rows.filter((r) => r.decision === 'approved').length;
    const notApproved = rows.filter((r) => r.decision === 'not_approved').length;
    const noResponse = rows.filter((r) => r.decision === 'no_response').length;
    const chair = chairStatus(minutesText, rows);
    const result = `${approvedCount} of ${rows.length} approved`
      + (notApproved ? `, ${notApproved} not approved` : '') + (noResponse ? `, ${noResponse} no response` : '')
      + (chair ? `; Chairperson's approval: ${chair}` : '');
    const footerEntries = rows.map((r) => (r.sig
      ? `${r.name}: ${DECISION_TEXT[r.decision]} ${r.when} [${r.id}]`
      : `${r.name}: No response`));
    const footer = footerFor(footerEntries, digest, stats, result);
    const doc = new Layout(stats, footer.height);
    const indian = /\nMINUTES OF THE MEETING\n/.test(minutesText) && /\nSubject: /.test(minutesText);
    const standard = !indian && minutesText.startsWith('MINUTES OF MEETING\n');
    if (indian) {
      layoutIndianMinutes(doc, minutesText, rows, logo && jpegSize(logo.bytes) ? logo : null);
    } else if (standard) {
      layoutStandardMinutes(doc, minutesText);
    } else {
      doc.text('Signed Meeting Minutes', { font: 'bold', size: 20, color: [0.12, 0.16, 0.42] });
      doc.space(4);
      doc.text(`Meeting: ${meeting.name || 'Meeting'}`, { size: 11 });
      doc.text(`Meeting ID: ${meeting.id || ''}`, { size: 10, color: [0.35, 0.35, 0.4] });
      doc.rule();
      doc.text('Minutes', { font: 'bold', size: 14 });
      doc.space(4);
      doc.text(minutesText, { size: 11 });
    }

    // Approval: a compact table here, and everyone's decision in the footer of every page.
    if (indian) {
      doc.space(16);
      doc.centered('ANNEXURE-II: APPROVAL OF THE MINUTES BY PARTICIPANTS', { size: 12, underline: true });
      doc.space(8);
    } else {
      doc.heading(standard ? `${(minutesText.match(/^\d+\. [A-Z]/gm) || []).length + 1}. APPROVAL` : 'Approval');
    }
    doc.text(`Result: ${result}.`, { font: 'bold', size: 10 });
    doc.space(4);
    const widths = [38, 100, 72, 129, 86, TEXT_W - 425];
    const header = () => doc.row([indian ? 'S. No.' : 'No.', 'Name', 'Decision', 'Reason', 'Date / time', 'Sig. ID']
      .map((text, k) => ({ text, w: widths[k], font: 'bold' })), { size: 8.5, pad: 2, border: true, fill: [0.92, 0.93, 0.97] });
    header();
    rows.forEach((r, k) => doc.row([
      String(k + 1),
      r.status ? `${r.name}\n(${r.status})` : r.name,
      DECISION_TEXT[r.decision],
      r.reason || (r.decision === 'no_response' ? 'Did not respond' : '-'),
      r.when || '-',
      r.id || '-'
    ].map((text, c) => ({ text, w: widths[c], font: c === 5 && r.id ? 'mono' : (c === 2 ? 'bold' : 'regular') })),
    { size: 8.5, pad: 2, border: true, repeatHeader: header }));
    doc.space(4);
    doc.text('Approvals and objections are signed electronically with software keys (ECDSA P-256), not with the USB token. '
      + 'An attendee who did not respond has not approved. Details to check the signatures, and the audit trail '
      + '(time and IP address of each decision), are in the separate verification file.',
    { size: 8, color: [0.35, 0.35, 0.4] });

    const blob = buildPdf(doc.pages, footer.ops, indian ? logo : null);
    const safeName = String(meeting.name || 'Meeting').replace(/[^\w-]+/g, '_').slice(0, 40);
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `Signed_Minutes_${safeName}_${day}.pdf`;
    return { blob, fileName, replaced: stats.replaced, hashChecked: Boolean(actual) };
  }

  /**
   * Everything needed to check the signatures later, as a small JSON file.
   * Kept out of the PDF so the minutes stay short.
   */
  async function makeVerificationFile({ meeting, minutesText, signatures }) {
    const digest = signatures[0].document_sha256;
    const actual = await sha256Hex(minutesText);
    if (actual && actual !== digest) {
      throw new Error('These minutes do not match the signed version, so no file was made.');
    }
    const data = {
      format: 'trusmeet-signed-minutes-verification/1',
      meeting: { name: meeting.name || '', id: meeting.id || '' },
      minutes_sha256: digest,
      audit_trail_note: 'audit_trail in each signature was recorded by the TrusMeet server when the decision arrived '
        + '(IP address as seen by the server, connection type, time). It is not covered by the signature.',
      how_to_check: 'For each signature: SHA-256 of minutes_text (UTF-8) must equal minutes_sha256 and the '
        + 'document_sha256 inside signed_payload; then verify signature_b64 (ECDSA P-256, SHA-256, DER) over the '
        + 'UTF-8 bytes of signed_payload with the public key in cert_pem, and check cert_pem was issued by the lab CA.',
      minutes_text: minutesText,
      signatures: await Promise.all(signatures.map(async (sig) => ({
        signature_id: await signatureId(sig.signature_b64),
        signed_by: sig.signed_by,
        decision: sig.decision || 'approved',
        reason: sig.reason || '',
        token_status: sig.assurance,
        signed_at: sig.timestamp,
        algorithm: sig.algorithm,
        signed_payload: sig.signed_payload,
        signature_b64: sig.signature_b64,
        cert_serial: sig.cert_serial,
        cert_pem: sig.cert_pem,
        // Recorded by the server when the decision arrived. Not part of the signature.
        audit_trail: sig.audit ? {
          ip_address: sig.audit.ip,
          connection: sig.audit.connection,
          recorded_at: sig.audit.recorded_at,
          recorded_by: sig.audit.recorded_by
        } : null
      })))
    };
    const safeName = String(meeting.name || 'Meeting').replace(/[^\w-]+/g, '_').slice(0, 40);
    return {
      blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      fileName: `Signed_Minutes_${safeName}_verification.json`
    };
  }

  window.makeSignedMinutesPdf = makeSignedMinutesPdf;
  window.makeMinutesVerificationFile = makeVerificationFile;
})();
