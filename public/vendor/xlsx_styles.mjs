// Mise en forme des classeurs XLSX. SheetJS communautaire (vendor/xlsx.full.min.js 0.18.5)
// n'écrit pas les styles des cellules : on construit la feuille avec une carte « cellule → nom de
// style », puis, après XLSX.write, on remplace xl/styles.xml et on pose les s="…" dans le XML des
// feuilles (JSZip), avec volet figé, plan repliable et mise en page paysage.
// Exposé en window.Rn.xlsxStyles par chaque site. Utilisé par l'export PR01.
//
// Style nommé : { police: { gras, italique, souligne, taille, couleur }, fond: 'RRGGBB',
//   bordure: true, aligne: { h: 'left'|'center'|'right', v: 'center', retour: true },
//   format: '[h]:mm' }

const lettreCol = (c) => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const ref = (r, c) => `${lettreCol(c)}${r + 1}`;

// Feuille en construction : chaque ligne reçoit ses valeurs et le nom de style de chaque cellule
// (un nom pour toute la ligne, ou un tableau). Valeur : texte, nombre, null (cellule vide mise en
// forme) ou cellule SheetJS { t, v, f } ; le format numérique vient du style (le « z » est retiré).
export function feuille() {
  const ws = {};
  const carte = new Map();
  const rows = [];
  const merges = [];
  let r = 0;
  let maxC = 0;
  const api = {
    ws,
    carte,
    get ligne() { return r; },
    ecrire(valeurs, styles, { hauteur, niveau } = {}) {
      valeurs.forEach((v, c) => {
        const style = Array.isArray(styles) ? styles[c] : styles;
        let cell;
        if (v && typeof v === 'object') {
          cell = { ...v };
          delete cell.z;
        } else if (typeof v === 'number' && Number.isFinite(v)) cell = { t: 'n', v };
        else cell = { t: 's', v: v == null ? '' : String(v) };
        ws[ref(r, c)] = cell;
        if (style) carte.set(ref(r, c), style);
      });
      maxC = Math.max(maxC, valeurs.length);
      if (hauteur || niveau) rows[r] = { ...(hauteur ? { hpt: hauteur } : {}), ...(niveau ? { level: niveau } : {}) };
      return r++;
    },
    sauter(n = 1) { r += n; },
    fusionner(ligne, c1, c2) { if (c2 > c1) merges.push({ s: { r: ligne, c: c1 }, e: { r: ligne, c: c2 } }); },
    // Bloc sur plusieurs lignes (ex. titre sur 2 lignes B2:H3).
    fusionnerBloc(l1, c1, l2, c2) { if (l2 > l1 || c2 > c1) merges.push({ s: { r: l1, c: c1 }, e: { r: l2, c: c2 } }); },
    largeurs(cols) { ws['!cols'] = cols.map(w => ({ wch: w })); },
    filtre(ligneEntete, nbCols, derniere) { ws['!autofilter'] = { ref: `${ref(ligneEntete, 0)}:${ref(Math.max(ligneEntete, derniere), nbCols - 1)}` }; },
    terminer() {
      ws['!ref'] = `A1:${ref(Math.max(0, r - 1), Math.max(0, maxC - 1))}`;
      if (rows.length) ws['!rows'] = rows;
      if (merges.length) ws['!merges'] = merges;
      return ws;
    }
  };
  return api;
}

const echap = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const argb = (hex) => `FF${String(hex || '000000').replace('#', '').toUpperCase()}`;

// styles.xml à partir des styles nommés (polices, fonds, formats et cellXfs dédoublonnés).
// Renvoie { xml, index: Map(nom → numéro de cellXfs) } ; le numéro 0 reste le style par défaut.
export function construireStylesXml(defs) {
  const fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>'
  ];
  const numFmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = new Map();
  const indice = (liste, xml) => { let i = liste.indexOf(xml); if (i < 0) { liste.push(xml); i = liste.length - 1; } return i; };
  for (const [nom, d] of Object.entries(defs || {})) {
    const p = d.police || {};
    const font = `<font>${p.gras ? '<b/>' : ''}${p.italique ? '<i/>' : ''}${p.souligne ? '<u/>' : ''}<sz val="${p.taille || 11}"/>${p.couleur ? `<color rgb="${argb(p.couleur)}"/>` : '<color theme="1"/>'}<name val="Calibri"/><family val="2"/></font>`;
    const fontId = indice(fonts, font);
    const fillId = d.fond ? indice(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(d.fond)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = d.bordure ? 1 : 0;
    let numFmtId = 0;
    if (d.format) {
      let i = numFmts.indexOf(d.format);
      if (i < 0) { numFmts.push(d.format); i = numFmts.length - 1; }
      numFmtId = 164 + i;
    }
    const a = d.aligne || {};
    const align = (a.h || a.v || a.retour) ? `<alignment${a.h ? ` horizontal="${a.h}"` : ''} vertical="${a.v || 'center'}"${a.retour ? ' wrapText="1"' : ''}/>` : '';
    xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}>${align}</xf>`);
    index.set(nom, xfs.length - 1);
  }
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${echap(f)}"/>`).join('')}</numFmts>` : '')
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
    + `<fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${borders.length}">${borders.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
  return { xml, index };
}

// XML d'une feuille : s="…" de chaque cellule selon la carte (les s posés par SheetJS sont retirés),
// volet figé, quadrillage, plan repliable (titre au-dessus du détail), onglet coloré, paysage.
export function appliquerFeuille(xml, carte, index, { figerLignes = 0, quadrillage = true, plan = false, couleurOnglet = null, paysage = true } = {}) {
  let out = xml.replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (m, r, rest, fin) => {
    const sans = rest.replace(/\s+s="\d+"/, '');
    const nom = carte.get(r);
    const s = nom != null && index.has(nom) ? ` s="${index.get(nom)}"` : '';
    return `<c r="${r}"${s}${sans}${fin}>`;
  });

  const vue = `<sheetView workbookViewId="0"${quadrillage ? '' : ' showGridLines="0"'}>${figerLignes > 0 ? `<pane ySplit="${figerLignes}" topLeftCell="A${figerLignes + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${figerLignes + 1}" sqref="A${figerLignes + 1}"/>` : ''}</sheetView>`;
  if (/<sheetViews>[\s\S]*?<\/sheetViews>/.test(out)) out = out.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, `<sheetViews>${vue}</sheetViews>`);
  else out = out.replace(/(<sheetData|<sheetFormatPr|<cols)/, `<sheetViews>${vue}</sheetViews>$1`);

  const sheetPr = `<sheetPr>${couleurOnglet ? `<tabColor rgb="${argb(couleurOnglet)}"/>` : ''}${plan ? '<outlinePr summaryBelow="0"/>' : ''}${paysage ? '<pageSetUpPr fitToPage="1"/>' : ''}</sheetPr>`;
  out = out.replace(/<sheetPr[^>]*\/>|<sheetPr[^>]*>[\s\S]*?<\/sheetPr>/, '');
  if (sheetPr !== '<sheetPr></sheetPr>') out = out.replace(/(<worksheet[^>]*>)/, `$1${sheetPr}`);

  if (plan) {
    const niveaux = [...out.matchAll(/outlineLevel="(\d+)"/g)].map(m => Number(m[1]));
    const max = niveaux.length ? Math.max(...niveaux) : 0;
    if (max) {
      if (/<sheetFormatPr[^>]*\/>/.test(out)) out = out.replace(/<sheetFormatPr([^>]*?)\s*\/>/, (m, a) => `<sheetFormatPr${a.replace(/\s*outlineLevelRow="\d+"/, '')} outlineLevelRow="${max}"/>`);
      else out = out.replace(/(<cols|<sheetData)/, `<sheetFormatPr defaultRowHeight="15" outlineLevelRow="${max}"/>$1`);
    }
  }

  if (paysage) {
    const setup = '<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>';
    out = out.replace(/<pageSetup[^>]*\/>/, '');
    if (/<pageMargins[^>]*\/>/.test(out)) out = out.replace(/(<pageMargins[^>]*\/>)/, `$1${setup}`);
    else out = out.replace('</worksheet>', `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>${setup}</worksheet>`);
  }
  return out;
}

// Écrit le classeur (XLSX.write), injecte styles, mises en forme et titres d'impression, renvoie
// le Blob. feuilles : [{ nom, carte, figerLignes, quadrillage, plan, couleurOnglet, titres: '$4:$4' }]
// dans l'ordre de wb.SheetNames.
export async function finaliser(XLSX, JSZip, wb, feuilles, defs) {
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  const { xml, index } = construireStylesXml(defs);
  zip.file('xl/styles.xml', xml);
  const titres = [];
  for (let i = 0; i < wb.SheetNames.length; i++) {
    const f = feuilles.find(x => x.nom === wb.SheetNames[i]);
    const chemin = `xl/worksheets/sheet${i + 1}.xml`;
    if (!f || !zip.file(chemin)) continue;
    zip.file(chemin, appliquerFeuille(await zip.file(chemin).async('text'), f.carte, index, f));
    if (f.titres) titres.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${echap(f.nom).replace(/'/g, "''")}'!${f.titres}</definedName>`);
  }
  if (titres.length && zip.file('xl/workbook.xml')) {
    let wbXml = await zip.file('xl/workbook.xml').async('text');
    wbXml = wbXml.includes('</definedNames>')
      ? wbXml.replace('</definedNames>', `${titres.join('')}</definedNames>`)
      : wbXml.replace(/(<\/sheets>)/, `$1<definedNames>${titres.join('')}</definedNames>`);
    zip.file('xl/workbook.xml', wbXml);
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// Téléchargement d'un Blob sous un nom de fichier.
export function telecharger(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}
