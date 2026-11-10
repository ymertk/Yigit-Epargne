// Lecture des relevés bancaires PDF (Société Générale et formats proches : colonnes Débit / Crédit)
// Utilisé par index.html ; s'appuie sur pdf.js (Mozilla, licence Apache 2.0) placé à côté.

const AMT = /^\d{1,3}(?:[ .  ]\d{3})*,\d{2}$/;
const toAmt = s => parseFloat(s.replace(/[ .  ]/g, '').replace(',', '.'));
const NOISE = /ADEME|suite\s*>>>|^(RA|GSP|SM)\d+$/i;

export async function extractPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width })));
  }
  return pages;
}

function toLines(items) {
  const it = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = []; let cur = null;
  for (const i of it) {
    if (cur && Math.abs(i.y - cur.last) <= 2.5) { cur.items.push(i); cur.last = i.y; }
    else { cur = { y: i.y, last: i.y, items: [i] }; lines.push(cur); }
  }
  lines.forEach(l => { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map(i => i.s).join(' '); });
  return lines;
}

function mkDate(s, yearHint) {
  let m = s.match(/^(\d{2})[\/.](\d{2})[\/.](\d{4})$/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})[\/.](\d{2})[\/.](\d{2})$/); if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})[\/.](\d{2})$/); if (m && yearHint) return `${yearHint}-${m[2]}-${m[1]}`;
  return null;
}

function cleanCompte(first, det) {
  let t = first.replace(/^\s*\d{6}\s+/, '').replace(/\b[0-9A-Z]*\d{6,}[0-9A-Z]*\b/g, '').replace(/\s+/g, ' ').trim();
  const info = {};
  det.forEach(d => { const m = d.match(/^(POUR CPTE DE|DE|POUR|MOTIF|REF|ID|CHEZ|MANDAT|DATE)\s*:\s*(.*)$/); if (m && !(m[1] in info)) info[m[1]] = m[2].trim(); });
  let typ = t;
  if (/^PRELEVEMENT EUROPEEN/.test(typ)) typ = 'PRLV';
  else if (/^VIR (EUROPEEN |INSTANTANE |PERMANENT )?EMIS/.test(typ)) typ = 'VIR EMIS';
  else if (/^(VIR (INST )?RECU|VIREMENT RECU|VIR INST RE)/.test(typ)) typ = 'VIR RECU';
  else if (/^ECHEANCE PRET/.test(typ)) {
    const j = det.join(' '), ext = [];
    for (const [k, lab] of [['CAPITAL AMORTI', 'capital amorti'], ['INTERETS', 'interets'], ['ASSURANCE', 'assurance'], ['CAPITAL RESTANT', 'capital restant']]) {
      const m = j.match(new RegExp(k + '\\s*:\\s*([\\d .]+,\\d\\d)')); if (m) ext.push(lab + ' ' + m[1].replace(/[ .]/g, ''));
    }
    return 'ECHEANCE PRET IMMO' + (ext.length ? ' - ' + ext.join(' - ') : '');
  }
  let party = info['POUR CPTE DE'] || info['DE'] || info['POUR'];
  if (party) {
    if (/^paypal/i.test(party)) party = 'PayPal';
    party = party.replace(/\bSOCIT\b/g, 'SOCIETE').replace(/MTROPOLE/g, 'METROPOLE');
    let lab = typ + ' ' + party; const mo = info['MOTIF'] || '';
    if (mo && !/^[\d \/.\-]+$/.test(mo) && typ !== 'PRLV') lab += ' - ' + mo;
    return lab;
  }
  return typ;
}

function cleanCard(first, det) {
  let l = /^COMMERCE ELECTRONIQUE/.test(first) && det.length ? det[0] : (det.length && /^RETRAIT/.test(first) ? first + ' ' + det[0] : first);
  l = l.replace(/\bFR(?=[A-Z][a-z])/g, '').replace(/\s(IRLANDE|ROYAUME-UNI|PAYS-BAS|ESPAGNE|MALTE|ETATS-UNIS D|LUXEMBOURG|ALLEMAGNE|BELGIQUE|ITALIE|DANEMARK|PORTUGAL|SUISSE)$/, '');
  return 'CB ' + l.replace(/\b(FR|\d{2})\b(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

// pages : [[{s,x,y,w}]] -> {kind, card, period, tx:[{date, amount, label, cardDebit?}], check:{ok, expected, found}}
export function parseStatement(pages) {
  const all = pages.map(toLines);
  const head = all[0].map(l => l.text).join('\n');
  const isCard = /RELEV[ÉE] CARTE|CARTE .*n° X{4}/i.test(head) && /Date d'arr[êe]t[ée]/i.test(head);
  const card = (head.match(/n° X{4} X{4} X{4} (\d{4})/) || [])[1] || null;
  const yearHint = (head.match(/(\d{4})/) || [])[1];
  let hdr = null, cur = null, totals = null;
  const tx = [];
  for (const lines of all) {
    for (const ln of lines) {
      const d = ln.items.find(i => /^D[ée]bit/i.test(i.s)), c = ln.items.find(i => /^Cr[ée]dit/i.test(i.s));
      if (d && c && /Date/i.test(ln.text)) { hdr = { dL: d.x, dR: d.x + d.w, cR: c.x + c.w }; cur = null; continue; }
      if (!hdr) continue;
      const items = ln.items.filter(i => i.x < hdr.cR + 15 && !NOISE.test(i.s));
      if (!items.length) continue;
      const txt = items.map(i => i.s).join(' ');
      const amts = items.filter(i => AMT.test(i.s) && i.x + i.w > hdr.dL - 45);
      const side = i => (i.x + i.w > (hdr.dR + hdr.cR) / 2 ? 'C' : 'D');
      if (/TOTAUX DES MOUVEMENTS|TOTAL NET DES OP/i.test(txt)) {
        const t = { D: 0, C: 0 }; amts.forEach(a => t[side(a)] += toAmt(a.s)); totals = (totals || { D: 0, C: 0 }); totals.D += t.D; totals.C += t.C; cur = null; continue;
      }
      if (/SOLDE PR[ÉE]C[ÉE]DENT|NOUVEAU SOLDE|SOLDE AU/i.test(txt)) { cur = null; continue; }
      const date = mkDate(items[0].s, yearHint);
      if (date && amts.length) {
        const a = amts[amts.length - 1];
        const lab = items.filter(i => i !== a && !(mkDate(i.s, yearHint) && i.x < hdr.dL / 2)).map(i => i.s).join(' ');
        cur = { date, amount: toAmt(a.s) * (side(a) === 'C' ? 1 : -1), first: lab.replace(/\s+/g, ' ').trim(), det: [], x: items.find(i => !mkDate(i.s, yearHint))?.x ?? 0 };
        tx.push(cur); continue;
      }
      if (cur && !amts.length && items[0].x >= cur.x - 3 && cur.det.length < 8) cur.det.push(txt);
      else cur = null;
    }
  }
  const out = tx.map(t => {
    const label = isCard ? cleanCard(t.first, t.det) : cleanCompte(t.first, t.det);
    const o = { date: t.date, amount: Math.round(t.amount * 100) / 100, label };
    const m = !isCard && t.first.match(/DEBIT MENSUEL CARTE.*X(\d{4})/); if (m) o.cardDebit = m[1];
    if (isCard && card) o.card = card;
    return o;
  });
  const D = Math.round(out.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0) * 100) / 100;
  const C = Math.round(out.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100;
  let check = null;
  if (totals) check = isCard ? { ok: Math.abs((totals.D - totals.C) - (D - C)) < 0.01, expected: totals.D - totals.C, found: D - C }
                             : { ok: Math.abs(totals.D - D) < 0.01 && Math.abs(totals.C - C) < 0.01, expected: totals.D, found: D };
  return { kind: isCard ? 'carte' : 'compte', card, tx: out, check };
}
