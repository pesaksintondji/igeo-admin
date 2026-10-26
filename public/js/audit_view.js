/**
 * Onglet « Audit » de admin.igeopilot.com : rapports, alertes et journal de connexion de track.igeo.africa.
 * Données : window.AuditEngine (collecte en lecture seule + analyse) ; export : window.AuditExport.
 * L'audit est chargé au premier affichage de l'onglet puis gardé en mémoire (bouton « Actualiser »).
 */
(function () {
  const AE = () => window.AuditEngine;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const normaliser = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const PERIODES = [
    { id: '30', libelle: '30 derniers jours', court: '30 j', jours: 30 },
    { id: '90', libelle: '90 derniers jours', court: '90 j', jours: 90 },
    { id: '365', libelle: '12 derniers mois', court: '12 mois', jours: 365 },
    { id: 'tout', libelle: 'Tout l\'historique (depuis 01/2025)', court: 'depuis 01/2025', jours: 0 }
  ];
  const ONGLETS = [
    { id: 'synthese', libelle: 'Synthèse', icon: 'insights' },
    { id: 'clients', libelle: 'Clients', icon: 'business' },
    { id: 'utilisateurs', libelle: 'Utilisateurs', icon: 'group' },
    { id: 'rapports', libelle: 'Rapports', icon: 'description' },
    { id: 'alertes', libelle: 'Alertes', icon: 'notifications_active' },
    { id: 'anomalies', libelle: 'Anomalies', icon: 'report' },
    { id: 'journal', libelle: 'Journal des modifications', icon: 'history' }
  ];
  const JOURS_SEMAINE = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const LIMITE_PAGE = 100;

  const vue = {
    statut: 'vide', // vide | chargement | pret | erreur
    progression: { message: '', part: 0 },
    erreur: '',
    brut: null,
    analyse: null,
    compte: '',
    periode: 'tout',
    onglet: 'synthese',
    recherche: {},
    filtres: {},
    tri: {},
    limites: {},
    lignesVisibles: {},
    journal: null,
    journalChargement: null,
    tiroir: null,
    export: false,
    sessionNom: null,
    sources: null,
    signature: ''
  };
  let ctx = null;
  let slotEl = null;

  // ── Formats ────────────────────────────────────────────────────────────────
  const nombre = (n) => (Number(n) || 0).toLocaleString('fr-FR');
  function duree(sec) {
    const s = Math.round(Number(sec) || 0);
    if (s < 60) return s ? '< 1 min' : '0 min';
    const j = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (j) return `${j} j ${h} h`;
    if (h) return `${h} h ${String(m).padStart(2, '0')}`;
    return `${m} min`;
  }
  const fmtDate = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Porto-Novo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Porto-Novo', day: '2-digit', month: '2-digit', year: 'numeric' });
  const date = (t) => (t ? fmtDate.format(new Date(t * 1000)) : '—');
  const jour = (t) => (t ? fmtJour.format(new Date(t * 1000)) : '—');
  function relatif(t) {
    if (!t) return 'jamais';
    const j = Math.floor((Date.now() / 1000 - t) / 86400);
    if (j <= 0) return 'aujourd\'hui';
    if (j === 1) return 'hier';
    if (j < 60) return `il y a ${j} j`;
    if (j < 730) return `il y a ${Math.round(j / 30)} mois`;
    return `il y a ${Math.round(j / 365)} ans`;
  }
  const moisLibelle = (cle) => {
    const [a, m] = cle.split('-');
    return `${MOIS_COURTS[Number(m) - 1]} ${a.slice(2)}`;
  };
  const periodeCourante = () => PERIODES.find(p => p.id === vue.periode) || PERIODES[3];
  const depuisPeriode = () => {
    const p = periodeCourante();
    return p.jours ? Math.floor(Date.now() / 1000) - p.jours * 86400 : 0;
  };

  const badge = (texte, ton = '', icon = '') => `<span class="aud-badge ${ton}">${icon ? `<span class="ms">${icon}</span>` : ''}${esc(texte)}</span>`;
  function badgeStatut(statut, supprime) {
    if (supprime) return badge('Supprimé', 'gris', 'person_off');
    if (/^Actif \(7/.test(statut)) return badge(statut, 'ok', 'check_circle');
    if (/^Actif/.test(statut)) return badge(statut, 'ok-doux', 'schedule');
    if (/^Dormant/.test(statut)) return badge(statut, 'warn', 'bedtime');
    if (/^Inactif/.test(statut)) return badge(statut, 'danger', 'block');
    return badge(statut, 'gris', 'remove_circle_outline');
  }
  const badgePriorite = (p) => badge(AE().PRIORITES[p], `prio${p}`, p === 1 ? 'error' : p === 2 ? 'warning' : 'info');
  const badgeType = (t) => badge(t, t === 'Interne' ? 'gris' : t === 'Revendeur' ? 'violet' : 'bleu');
  function badgesAnomalies(liste) {
    if (!liste || !liste.length) return '<span class="aud-muted">—</span>';
    const pire = Math.min(...liste.map(a => a.priorite));
    return `<span class="aud-badge prio${pire}" title="${esc(liste.map(a => a.texte).join('\n'))}"><span class="ms">${pire === 1 ? 'error' : pire === 2 ? 'warning' : 'info'}</span>${liste.length}</span> <span class="aud-anom-texte">${esc(liste[0].texte)}${liste.length > 1 ? ` (+${liste.length - 1})` : ''}</span>`;
  }
  const listeCourte = (valeurs, max = 2) => {
    if (valeurs == null) return '<span class="aud-muted" title="Détail non lu (droits)">non lu</span>';
    if (!valeurs.length) return '<span class="aud-muted">—</span>';
    const visibles = valeurs.slice(0, max).map(esc).join(', ');
    return `<span title="${esc(valeurs.join('\n'))}">${visibles}${valeurs.length > max ? ` <span class="aud-muted">+${valeurs.length - max}</span>` : ''}</span>`;
  };

  // ── Chargement ─────────────────────────────────────────────────────────────
  function compteSession() {
    const s = ctx.state.session || {};
    if (s.accountId) return Number(s.accountId);
    const u = ctx.state.users.find(x => x.name === s.userName);
    return u ? Number(u.accountId) : 0;
  }

  async function charger() {
    const { api, engine, state } = ctx;
    vue.statut = 'chargement';
    vue.erreur = '';
    const progres = (debut, fin) => (message, part) => {
      vue.progression = { message, part: debut + (fin - debut) * Math.max(0, Math.min(1, part || 0)) };
      majProgression();
    };
    dessiner();
    try {
      const compteRacineId = compteSession();
      if (!compteRacineId) throw new Error('Compte de la session introuvable');
      const configuration = await AE().collecterConfiguration(api, { onProgress: progres(0, 0.2) });
      progres(0.2, 0.25)('Droits des utilisateurs sur les véhicules…', 0);
      const acces = await AE().collecterAcces(api, state.units.map(u => u.id));
      const connexions = await AE().collecterConnexions(api, compteRacineId, { onProgress: progres(0.25, 0.97) });
      progres(0.97, 1)('Analyse…', 0);
      vue.sources = { configuration, acces, connexions, compteRacineId };
      vue.brut = AE().preparerBrut({ engine, state, configuration, acces, connexions, compteRacineId, session: state.session });
      vue.signature = signatureAdmin(vue.brut);
      const racine = configuration.ressources.find(r => r.id === compteRacineId);
      vue.compte = racine ? racine.nom : `#${compteRacineId}`;
      vue.journal = null;
      recalculer();
      vue.statut = 'pret';
    } catch (e) {
      vue.statut = 'erreur';
      vue.erreur = e && e.code === 1 ? 'Session Igeo expirée : reconnectez-vous.' : (e && e.message) || 'Erreur inconnue';
    }
    dessiner();
  }

  // Données réglées dans les autres onglets d'admin.igeopilot (type d'utilisateur, client des véhicules,
  // groupes multi-clients) : relues à chaque retour sur l'onglet, sans relire le journal de connexion.
  function signatureAdmin(brut) {
    return JSON.stringify([
      brut.utilisateurs.map(u => [u.id, u.role, u.compteId]),
      brut.unites.map(u => [u.id, u.clientField]),
      brut.groupes.map(g => [g.id, g.multiClient, g.clientSpa, g.unitIds.length])
    ]);
  }

  function reprendreReglagesAdmin() {
    if (vue.statut !== 'pret' || !vue.sources) return;
    const brut = AE().preparerBrut({ engine: ctx.engine, state: ctx.state, ...vue.sources, session: ctx.state.session });
    const signature = signatureAdmin(brut);
    if (signature === vue.signature) return;
    brut.genereLe = vue.brut.genereLe; // les statuts restent calculés à la date de lecture du journal
    vue.brut = brut;
    vue.signature = signature;
    recalculer();
  }

  function recalculer() {
    vue.analyse = AE().analyser(vue.brut, { depuis: depuisPeriode() });
    vue.limites = {};
  }

  async function chargerJournal() {
    if (vue.journalChargement) return;
    const ids = new Set();
    for (const t of vue.brut.alertes) ids.add(t.ressourceId);
    for (const t of vue.brut.taches) ids.add(t.ressourceId);
    for (const t of vue.brut.modeles) ids.add(t.ressourceId);
    const ressources = vue.brut.ressources.filter(r => ids.has(r.id) || r.compteId === r.id);
    vue.journalChargement = { message: 'Démarrage…', part: 0 };
    dessiner();
    try {
      vue.journal = await AE().collecterJournal(ctx.api, ressources, {
        jours: 90,
        onProgress: (message, part) => {
          vue.journalChargement = { message, part };
          majProgression();
        }
      });
    } catch (e) {
      ctx.toast((e && e.message) || 'Lecture du journal impossible', 'error');
    }
    vue.journalChargement = null;
    dessiner();
  }

  async function exporterExcel() {
    if (vue.export) return;
    vue.export = true;
    dessiner();
    try {
      const res = await window.AuditExport.exporter({ brut: vue.brut, analyse: vue.analyse, journal: vue.journal, periode: { ...periodeCourante(), depuis: depuisPeriode() }, compte: vue.compte });
      ctx.toast(`Excel exporté : ${res.feuilles} feuilles, ${nombre(res.sessions)} sessions`);
    } catch (e) {
      ctx.toast((e && e.message) || 'Export Excel impossible', 'error');
    }
    vue.export = false;
    dessiner();
  }

  // ── Tableaux génériques (tri, recherche, filtres, pagination) ───────────────
  function comparer(a, b) {
    if (typeof a === 'number' || typeof b === 'number') return (Number(a) || 0) - (Number(b) || 0);
    return String(a || '').localeCompare(String(b || ''), 'fr', { sensitivity: 'base' });
  }

  function filtrer(id, lignes, texte, filtres = []) {
    const q = normaliser(vue.recherche[id] || '');
    const actifs = vue.filtres[id] || {};
    return lignes.filter(l => {
      if (q && !normaliser(texte(l)).includes(q)) return false;
      for (const f of filtres) {
        const v = actifs[f.cle];
        if (v !== undefined && v !== '' && !f.test(l, v)) return false;
      }
      return true;
    });
  }

  function tableau(id, colonnes, lignes, { triDefaut, clic = false, vide = 'Aucune ligne' } = {}) {
    const tri = vue.tri[id] || triDefaut || {};
    let rows = lignes;
    const colTri = colonnes.find(c => c.id === tri.col);
    if (colTri && colTri.tri) rows = rows.slice().sort((a, b) => comparer(colTri.tri(a), colTri.tri(b)) * (tri.sens || 1));
    const limite = vue.limites[id] || LIMITE_PAGE;
    const visibles = rows.slice(0, limite);
    vue.lignesVisibles[id] = visibles;
    const fleche = (c) => (c.id === tri.col ? `<span class="ms aud-tri">${tri.sens < 0 ? 'arrow_downward' : 'arrow_upward'}</span>` : '');
    return `
      <div class="adm-matrix-card">
        <div class="adm-matrix-scroll aud-scroll">
          <table class="adm-matrix aud-table">
            <thead><tr>${colonnes.map(c => `<th class="${c.tri ? 'aud-triable' : ''} ${c.num ? 'num' : ''}" ${c.tri ? `data-aud-tri="${id}:${c.id}"` : ''} title="${esc(c.aide || '')}">${esc(c.titre)}${fleche(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${visibles.length ? visibles.map((r, i) => `<tr class="adm-row ${clic ? 'aud-clic' : ''}" ${clic ? `data-aud-ligne="${id}:${i}" tabindex="0"` : ''}>${colonnes.map(c => `<td class="${c.num ? 'num' : ''} ${c.classe || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${colonnes.length}"><div class="adm-empty">${esc(vide)}</div></td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="aud-pied">
          <span>${rows.length > limite ? `${nombre(limite)} sur ${nombre(rows.length)} lignes` : `${nombre(rows.length)} ligne${rows.length > 1 ? 's' : ''}`}</span>
          ${rows.length > limite ? `<button type="button" class="adm-btn" data-aud-plus="${id}"><span class="ms">expand_more</span> Afficher ${nombre(Math.min(LIMITE_PAGE, rows.length - limite))} de plus</button>` : ''}
        </div>
      </div>`;
  }

  // Barre d'outils : recherche + filtres (menus Notion).
  function barre(id, placeholder, filtres = [], droite = '') {
    const actifs = vue.filtres[id] || {};
    return `
      <div class="adm-toolbar aud-toolbar">
        <div class="adm-search-box">
          <span class="ms">search</span>
          <input type="search" class="adm-input" data-aud-recherche="${id}" placeholder="${esc(placeholder)}" value="${esc(vue.recherche[id] || '')}">
        </div>
        ${filtres.map(f => {
          const v = actifs[f.cle];
          const choisi = f.items.find(it => String(it.value) === String(v ?? ''));
          const actif = v !== undefined && v !== '';
          return `<button type="button" class="notion-modal-dropdown-trigger aud-trigger ${actif ? 'actif' : ''}" data-aud-filtre="${id}:${f.cle}">
            <span class="ms">${esc(f.icon || 'filter_list')}</span>
            <span class="aud-trigger-label">${esc(actif && choisi ? choisi.label : f.titre)}</span>
            <span class="ms">arrow_drop_down</span>
          </button>`;
        }).join('')}
        ${droite}
      </div>`;
  }
  // Définitions des filtres de la vue courante (pour ouvrir le menu au clic).
  let filtresCourants = {};

  // ── Graphiques ─────────────────────────────────────────────────────────────
  function graduations(max) {
    if (max <= 0) return [0];
    const brut = max / 4;
    const p = 10 ** Math.floor(Math.log10(brut));
    const pas = [1, 2, 2.5, 5, 10].map(k => k * p).find(k => k >= brut) || brut;
    const out = [];
    for (let v = 0; v <= max + pas * 0.001; v += pas) out.push(Math.round(v));
    if (out[out.length - 1] < max) out.push(Math.round(out[out.length - 1] + pas));
    return out;
  }

  // Colonnes « sessions par mois » : une seule série, 4 px arrondis au sommet, valeur max étiquetée.
  function colonnesMois(parMois) {
    if (!parMois.length) return '<div class="adm-empty">Aucune connexion sur la période</div>';
    const W = 720;
    const H = 230;
    const g = { haut: 18, bas: 26, gauche: 44, droite: 8 };
    const ticks = graduations(Math.max(...parMois.map(m => m.sessions)));
    const max = ticks[ticks.length - 1] || 1;
    const bande = (W - g.gauche - g.droite) / parMois.length;
    const larg = Math.max(4, Math.min(24, bande * 0.62));
    const y = (v) => g.haut + (H - g.haut - g.bas) * (1 - v / max);
    const iMax = parMois.reduce((im, m, i) => (m.sessions > parMois[im].sessions ? i : im), 0);
    const pasLabel = Math.ceil(parMois.length / 12);
    const barre = (x, yh, w, h) => {
      const r = Math.min(4, w / 2, h);
      return `M${x},${yh + h}V${yh + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${yh + h}Z`;
    };
    return `
      <svg class="aud-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions par mois">
        ${ticks.map(t => `<line class="aud-grille" x1="${g.gauche}" x2="${W - g.droite}" y1="${y(t)}" y2="${y(t)}"/><text class="aud-axe" x="${g.gauche - 6}" y="${y(t) + 3.5}" text-anchor="end">${nombre(t)}</text>`).join('')}
        ${parMois.map((m, i) => {
          const cx = g.gauche + bande * i + bande / 2;
          const h = Math.max(0, H - g.bas - y(m.sessions));
          const tip = `${moisLibelle(m.mois)}\n${nombre(m.sessions)} sessions\n${nombre(m.utilisateurs)} utilisateurs connectés`;
          return `<g class="aud-cible" data-tip="${esc(tip)}" tabindex="0">
            <rect class="aud-zone" x="${g.gauche + bande * i}" y="${g.haut}" width="${bande}" height="${H - g.haut - g.bas}"/>
            ${h > 0 ? `<path class="aud-barre" d="${barre(cx - larg / 2, H - g.bas - h, larg, h)}"/>` : ''}
            ${i === iMax ? `<text class="aud-etiquette" x="${cx}" y="${H - g.bas - h - 5}" text-anchor="middle">${nombre(m.sessions)}</text>` : ''}
            ${i % pasLabel === 0 ? `<text class="aud-axe" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(moisLibelle(m.mois))}</text>` : ''}
          </g>`;
        }).join('')}
        <line class="aud-base" x1="${g.gauche}" x2="${W - g.droite}" y1="${H - g.bas}" y2="${H - g.bas}"/>
      </svg>`;
  }

  // Barres horizontales (une série) : libellé, barre, valeur au bout.
  function barresListe(items, { suffixe = '', clic } = {}) {
    if (!items.length) return '<div class="adm-empty">Aucune donnée</div>';
    const max = Math.max(...items.map(i => i.valeur)) || 1;
    return `<div class="aud-barres">${items.map(it => `
      <div class="aud-barre-ligne ${clic ? 'aud-clic' : ''}" data-tip="${esc(it.tip || `${it.libelle}\n${nombre(it.valeur)}${suffixe}`)}" tabindex="0" ${clic ? `data-aud-aller="${esc(clic(it))}"` : ''}>
        <span class="aud-barre-lib">${esc(it.libelle)}</span>
        <span class="aud-barre-piste"><span class="aud-barre-rempli" style="width:${Math.max(0.5, (100 * it.valeur) / max).toFixed(2)}%"></span></span>
        <span class="aud-barre-val">${nombre(it.valeur)}${it.detail ? ` <span class="aud-muted">${esc(it.detail)}</span>` : ''}</span>
      </div>`).join('')}</div>`;
  }

  // Carte de chaleur jour × heure : une teinte, de la surface vers le bleu.
  function carteChaleur(heatmap) {
    const max = Math.max(1, ...heatmap.flat());
    const cell = (v, j, h) => {
      const p = v ? 12 + Math.round(88 * (v / max)) : 0;
      return `<span class="aud-cellule" style="--p:${p}%" data-tip="${esc(`${JOURS_SEMAINE[j]} ${String(h).padStart(2, '0')} h – ${String(h + 1).padStart(2, '0')} h\n${nombre(v)} connexions`)}" tabindex="0"></span>`;
    };
    return `
      <div class="aud-chaleur">
        <span></span>${Array.from({ length: 24 }, (_x, h) => `<span class="aud-axe-h">${h % 3 === 0 ? `${h}h` : ''}</span>`).join('')}
        ${heatmap.map((ligne, j) => `<span class="aud-axe-j">${JOURS_SEMAINE[j].slice(0, 3)}.</span>${ligne.map((v, h) => cell(v, j, h)).join('')}`).join('')}
      </div>
      <div class="aud-legende-chaleur"><span>0</span><span class="aud-degrade"></span><span>${nombre(max)} connexions / heure</span></div>`;
  }

  // ── Vues ───────────────────────────────────────────────────────────────────
  function kpi(icone, couleur, valeur, libelle, aller) {
    return `<div class="adm-kpi-card aud-kpi ${aller ? 'aud-clic' : ''}" ${aller ? `data-aud-aller="${esc(aller)}" tabindex="0"` : ''}>
      <div class="adm-kpi-icon" style="background:color-mix(in srgb, ${couleur} 14%, transparent);color:${couleur};"><span class="ms">${icone}</span></div>
      <div><div class="adm-kpi-val">${valeur}</div><div class="adm-kpi-lbl">${libelle}</div></div>
    </div>`;
  }

  function vueSynthese() {
    const a = vue.analyse;
    const s = a.synthese;
    const actifs30 = (s.parStatut['Actif (7 j)'] || 0) + (s.parStatut['Actif (30 j)'] || 0);
    const totalFam = s.familles.reduce((x, f) => x + f.sessions, 0) || 1;
    const topClients = a.clients.filter(c => c.type === 'Client' && c.sessions && c.nom !== 'Non rattaché' && !/^Multi-clients/.test(c.nom)).slice(0, 10);
    return `
      <div class="adm-kpi-strip aud-kpis">
        ${kpi('business', 'var(--primary)', nombre(s.clients), `Clients · ${nombre(s.vehicules)} véhicules`, 'onglet:clients')}
        ${kpi('group', '#0f766e', `${nombre(actifs30)} / ${nombre(s.parType.Client + s.parType.Revendeur)}`, 'Utilisateurs clients actifs (30 j)', 'onglet:utilisateurs')}
        ${kpi('login', '#2563eb', nombre(s.sessionsClients), `Sessions clients · ${esc(periodeCourante().court)}`)}
        ${kpi('timer', '#7c3aed', duree(s.dureeMoyenneClients), `Session moyenne · ${duree(s.dureeClients)} au total`)}
        ${kpi('notifications_active', 'var(--warn)', `${nombre(s.alertes.actives)} / ${nombre(s.alertes.total)}`, 'Alertes actives', 'onglet:alertes')}
        ${kpi('schedule_send', 'var(--success)', `${nombre(s.taches.actives)} / ${nombre(s.taches.total)}`, `Rapports planifiés actifs · ${nombre(s.taches.envois)} envois`, 'onglet:rapports')}
        ${kpi('error', 'var(--danger)', nombre(s.anomalies.haute), `Anomalies hautes · ${nombre(s.anomalies.moyenne)} moyennes`, 'anomalies:1')}
      </div>

      <div class="aud-grille-2">
        <section class="aud-carte">
          <header><h3>Connexions des clients par mois</h3><p>Sessions ouvertes par les utilisateurs clients et revendeurs, hors comptes internes et API / jeton.</p></header>
          ${colonnesMois(s.parMois)}
        </section>
        <section class="aud-carte">
          <header><h3>Applications utilisées</h3><p>Sessions clients par application · utilisateurs distincts entre parenthèses.</p></header>
          ${barresListe(s.familles.map(f => ({ libelle: f.famille, valeur: f.sessions, detail: `${Math.round((100 * f.sessions) / totalFam)} % · ${nombre(f.utilisateurs)} util.`, tip: `${f.famille}\n${nombre(f.sessions)} sessions (${Math.round((100 * f.sessions) / totalFam)} %)\n${nombre(f.utilisateurs)} utilisateurs` })), { clic: f => `famille:${f.libelle}` })}
          <p class="aud-note"><span class="ms">info</span> Web = track.igeo.africa (et l'ancien track.cobi.africa) · Android / iOS = applications mobiles · Locator = liens de suivi partagés.</p>
        </section>
        <section class="aud-carte">
          <header><h3>Heures de connexion</h3><p>Connexions des clients par jour et par heure (heure du Bénin).</p></header>
          ${carteChaleur(s.heatmap)}
        </section>
        <section class="aud-carte">
          <header><h3>Statut des utilisateurs</h3><p>Selon la dernière connexion, quelle que soit la période choisie (clients et revendeurs).</p></header>
          ${barresListe(AE().STATUTS.map(st => ({ libelle: st, valeur: s.parStatut[st] || 0 })), { suffixe: ' utilisateurs', clic: it => `statut:${it.libelle}` })}
        </section>
      </div>

      <section class="aud-carte">
        <header><h3>Clients les plus actifs</h3><p>${esc(periodeCourante().libelle)} · cliquer pour le détail.</p></header>
        ${tableau('topClients', colonnesClients().filter(c => ['nom', 'utilisateurs', 'sessions', 'duree', 'derniere', 'app', 'vehicules', 'alertes', 'rapports'].includes(c.id)), topClients, { clic: true })}
      </section>

      <div class="aud-info">
        <span class="ms">info</span>
        <div>
          <strong>Ce que Wialon enregistre.</strong> Les connexions (début, fin, adresse IP, application) et les modifications de configuration.
          Wialon <strong>n'enregistre pas les rapports lancés à la main</strong> : les rapports « utilisés » sont ceux des rapports planifiés
          (nombre d'envois, dernier envoi) et les modèles disponibles sur chaque compte. Une session restée ouverte (application mobile) compte au plus 24 h.
        </div>
      </div>`;
  }

  function colonnesClients() {
    return [
      { id: 'nom', titre: 'Client', tri: c => c.nom, html: c => `<div class="aud-nom">${esc(c.nom)}</div>${c.type === 'Revendeur' ? badgeType('Revendeur') : ''}` },
      { id: 'utilisateurs', titre: 'Utilisateurs', num: true, tri: c => c.utilisateurs, aide: 'Actifs dans les 30 derniers jours / total', html: c => `${nombre(c.actifs30)} <span class="aud-muted">/ ${nombre(c.utilisateurs)}</span>` },
      { id: 'sessions', titre: 'Sessions', num: true, tri: c => c.sessions, html: c => nombre(c.sessions) },
      { id: 'duree', titre: 'Temps connecté', num: true, tri: c => c.duree, html: c => duree(c.duree) },
      { id: 'derniere', titre: 'Dernière connexion', tri: c => c.derniere, html: c => `<span title="${esc(date(c.derniere))}">${esc(relatif(c.derniere))}</span>` },
      { id: 'statut', titre: 'Statut', tri: c => AE().STATUTS.indexOf(c.statut), html: c => badgeStatut(c.statut) },
      { id: 'app', titre: 'Application', tri: c => c.appPrincipale, html: c => esc(c.appPrincipale || '—') },
      { id: 'vehicules', titre: 'Véhicules', num: true, tri: c => c.vehicules, html: c => `${nombre(c.vehiculesActifs)}${c.vehicules !== c.vehiculesActifs ? ` <span class="aud-muted">/ ${nombre(c.vehicules)}</span>` : ''}` },
      { id: 'alertes', titre: 'Alertes', num: true, tri: c => c.alertesActives, aide: 'Actives (désactivées)', html: c => `${nombre(c.alertesActives)}${c.alertesInactives ? ` <span class="aud-muted">(${nombre(c.alertesInactives)})</span>` : ''}` },
      { id: 'rapports', titre: 'Rapports planifiés', num: true, tri: c => c.rapportsActifs, aide: 'Actifs · nombre d\'envois', html: c => `${nombre(c.rapportsActifs)}${c.envois ? ` <span class="aud-muted">· ${nombre(c.envois)} envois</span>` : ''}` },
      { id: 'anomalies', titre: 'Anomalies', tri: c => (c.anomalies.length ? 10 - Math.min(...c.anomalies.map(x => x.priorite)) : 0), html: c => badgesAnomalies(c.anomalies) }
    ];
  }

  function vueClients() {
    const filtres = [
      { cle: 'type', titre: 'Tous les types', icon: 'category', items: [{ value: '', label: 'Tous les types' }, { value: 'Client', label: 'Clients' }, { value: 'Revendeur', label: 'Revendeurs' }], test: (c, v) => c.type === v },
      { cle: 'statut', titre: 'Toutes les activités', icon: 'monitor_heart', items: [{ value: '', label: 'Toutes les activités' }, ...AE().STATUTS.map(s => ({ value: s, label: s }))], test: (c, v) => c.statut === v },
      { cle: 'anomalie', titre: 'Avec ou sans anomalie', icon: 'report', items: [{ value: '', label: 'Avec ou sans anomalie' }, { value: 'oui', label: 'Avec anomalie' }, { value: 'non', label: 'Sans anomalie' }], test: (c, v) => (v === 'oui' ? c.anomalies.length > 0 : !c.anomalies.length) }
    ];
    filtresCourants.clients = filtres;
    const lignes = filtrer('clients', vue.analyse.clients, c => `${c.nom} ${c.listeUtilisateurs.join(' ')}`, filtres);
    return `${barre('clients', 'Rechercher un client ou un utilisateur…', filtres)}
      ${tableau('clients', colonnesClients(), lignes, { triDefaut: { col: 'sessions', sens: -1 }, clic: true })}`;
  }

  function colonnesUtilisateurs() {
    return [
      { id: 'nom', titre: 'Utilisateur', tri: u => u.nom, html: u => `<div class="aud-nom">${esc(u.nom)}</div><div class="aud-sous">${esc(u.compte)}${u.role ? ` · ${esc(u.role)}` : ''}</div>` },
      { id: 'type', titre: 'Type', tri: u => u.type, html: u => badgeType(u.type) },
      { id: 'client', titre: 'Client', tri: u => u.client, html: u => esc(u.client) },
      { id: 'statut', titre: 'Statut', tri: u => AE().STATUTS.indexOf(u.statut), html: u => badgeStatut(u.statut, u.supprime) },
      { id: 'derniere', titre: 'Dernière connexion', tri: u => u.derniere, html: u => (u.derniere ? `<div>${esc(date(u.derniere))}</div><div class="aud-sous">${esc(relatif(u.derniere))}</div>` : '<span class="aud-muted">jamais</span>') },
      { id: 'sessions', titre: 'Sessions', num: true, tri: u => u.sessions, aide: 'Sur la période (historique complet en gris)', html: u => `${nombre(u.sessions)}${u.sessionsTotal !== u.sessions ? ` <span class="aud-muted">/ ${nombre(u.sessionsTotal)}</span>` : ''}` },
      { id: 'duree', titre: 'Temps connecté', num: true, tri: u => u.duree, html: u => duree(u.duree) },
      { id: 'mediane', titre: 'Session médiane', num: true, tri: u => u.dureeMediane, html: u => (u.sessions ? duree(u.dureeMediane) : '—') },
      { id: 'jours', titre: 'Jours actifs', num: true, tri: u => u.joursActifs, html: u => nombre(u.joursActifs) },
      { id: 'app', titre: 'Application principale', tri: u => u.appPrincipale, html: u => esc(u.appPrincipale || '—') },
      { id: 'vehicules', titre: 'Véhicules', num: true, tri: u => u.vehicules, aide: 'Véhicules visibles par l\'utilisateur', html: u => nombre(u.vehicules) }
    ];
  }

  function vueUtilisateurs() {
    const familles = [...new Set(vue.analyse.applications.map(a => a.famille))];
    const clients = [...new Set(vue.analyse.utilisateurs.map(u => u.client))].sort((a, b) => a.localeCompare(b, 'fr'));
    const filtres = [
      { cle: 'type', titre: 'Tous les types', icon: 'category', items: [{ value: '', label: 'Tous les types' }, ...['Client', 'Revendeur', 'Interne'].map(t => ({ value: t, label: t }))], test: (u, v) => u.type === v },
      { cle: 'statut', titre: 'Tous les statuts', icon: 'monitor_heart', items: [{ value: '', label: 'Tous les statuts' }, ...AE().STATUTS.map(s => ({ value: s, label: s })), { value: 'Supprimé', label: 'Supprimés' }], test: (u, v) => (v === 'Supprimé' ? u.supprime : !u.supprime && u.statut === v) },
      { cle: 'famille', titre: 'Toutes les applications', icon: 'devices', items: [{ value: '', label: 'Toutes les applications' }, ...familles.map(f => ({ value: f, label: f }))], test: (u, v) => (u.familles[v] || 0) > 0 },
      { cle: 'client', titre: 'Tous les clients', icon: 'business', items: [{ value: '', label: 'Tous les clients' }, ...clients.map(c => ({ value: c, label: c }))], test: (u, v) => u.client === v }
    ];
    filtresCourants.utilisateurs = filtres;
    const lignes = filtrer('utilisateurs', vue.analyse.utilisateurs, u => `${u.nom} ${u.client} ${u.compte}`, filtres);
    return `${barre('utilisateurs', 'Rechercher un utilisateur, un client, un compte…', filtres)}
      ${tableau('utilisateurs', colonnesUtilisateurs(), lignes, { triDefaut: { col: 'sessions', sens: -1 }, clic: true })}`;
  }

  function vueRapports() {
    const a = vue.analyse;
    const comptes = [...new Set(a.taches.map(t => t.compte))].sort((x, y) => x.localeCompare(y, 'fr'));
    const filtres = [
      { cle: 'etat', titre: 'Tous les états', icon: 'toggle_on', items: [{ value: '', label: 'Tous les états' }, { value: 'actif', label: 'Actifs' }, { value: 'inactif', label: 'Désactivés' }, { value: 'anomalie', label: 'Avec anomalie (haute / moyenne)' }], test: (t, v) => (v === 'actif' ? t.actif : v === 'inactif' ? !t.actif : t.anomalies.some(x => x.priorite < 3)) },
      { cle: 'compte', titre: 'Tous les comptes', icon: 'account_tree', items: [{ value: '', label: 'Tous les comptes' }, ...comptes.map(c => ({ value: c, label: c }))], test: (t, v) => t.compte === v }
    ];
    filtresCourants.rapports = filtres;
    const lignes = filtrer('rapports', a.taches, t => `${t.nom} ${t.compte} ${t.client} ${t.modele} ${(t.emails || []).join(' ')} ${t.objets.join(' ')}`, filtres);
    const colonnes = [
      { id: 'nom', titre: 'Rapport planifié', tri: t => t.nom, html: t => `<div class="aud-nom">${esc(t.nom)}</div><div class="aud-sous">${esc(t.type)} · ${esc(t.ressource)}</div>` },
      { id: 'etat', titre: 'État', tri: t => (t.actif ? 1 : 0), html: t => (t.actif ? badge('Actif', 'ok', 'play_circle') : badge('Désactivé', 'gris', 'pause_circle')) },
      { id: 'client', titre: 'Client', tri: t => t.client, html: t => esc(t.client) },
      { id: 'modele', titre: 'Modèle', tri: t => t.modele, html: t => (t.modele ? esc(t.modele) : '<span class="aud-muted">—</span>') },
      { id: 'periodicite', titre: 'Périodicité', tri: t => t.periodeSec, html: t => `${esc(t.periodicite)}${t.formats ? `<div class="aud-sous">${esc(t.formats)}</div>` : ''}` },
      { id: 'dest', titre: 'Destinataires', tri: t => (t.emails || []).length, html: t => listeCourte(t.emails && t.telephones ? [...t.emails, ...t.telephones] : t.emails) },
      { id: 'envois', titre: 'Envois', num: true, tri: t => t.envois, html: t => nombre(t.envois) },
      { id: 'dernier', titre: 'Dernier envoi', tri: t => t.dernierEnvoi, html: t => (t.dernierEnvoi ? `<span title="${esc(date(t.dernierEnvoi))}">${esc(relatif(t.dernierEnvoi))}</span>` : '<span class="aud-muted">jamais</span>') },
      { id: 'anomalies', titre: 'Anomalies', tri: t => (t.anomalies.length ? 10 - Math.min(...t.anomalies.map(x => x.priorite)) : 0), html: t => badgesAnomalies(t.anomalies) }
    ];
    const modeles = filtrer('rapports', a.modeles, m => `${m.nom} ${m.compte} ${m.ressource} ${m.tables.join(' ')}`, []);
    const colonnesModeles = [
      { id: 'nom', titre: 'Modèle de rapport', tri: m => m.nom, html: m => `<div class="aud-nom">${esc(m.nom)}</div><div class="aud-sous">${esc(m.ressource)}</div>` },
      { id: 'type', titre: 'Objet', tri: m => m.type, html: m => esc(m.type) },
      { id: 'tables', titre: 'Tableaux', tri: m => m.tables.length, html: m => listeCourte(m.tables, 4) },
      { id: 'taches', titre: 'Rapports planifiés', num: true, tri: m => m.tachesActives, html: m => `${nombre(m.tachesActives)}${m.taches !== m.tachesActives ? ` <span class="aud-muted">/ ${nombre(m.taches)}</span>` : ''}` },
      { id: 'envois', titre: 'Envois', num: true, tri: m => m.envois, html: m => nombre(m.envois) },
      { id: 'modifie', titre: 'Modifié le', tri: m => m.modifie, html: m => esc(jour(m.modifie)) }
    ];
    return `
      <div class="aud-info"><span class="ms">info</span><div>Wialon n'enregistre pas les rapports lancés à la main par les utilisateurs. Les rapports réellement consommés sont les <strong>rapports planifiés</strong> ci-dessous (envois cumulés et dernier envoi), puis les modèles disponibles sur chaque compte.</div></div>
      ${barre('rapports', 'Rechercher un rapport, un client, un destinataire…', filtres)}
      <h3 class="aud-titre-section">Rapports planifiés <span class="aud-muted">${nombre(lignes.length)}</span></h3>
      ${tableau('rapports', colonnes, lignes, { triDefaut: { col: 'envois', sens: -1 }, clic: true })}
      <h3 class="aud-titre-section">Modèles de rapports <span class="aud-muted">${nombre(modeles.length)}</span></h3>
      ${tableau('modeles', colonnesModeles, modeles, { triDefaut: { col: 'envois', sens: -1 } })}`;
  }

  function vueAlertes() {
    const a = vue.analyse;
    const declencheurs = [...new Set(a.alertes.map(x => x.declencheur))].sort((x, y) => x.localeCompare(y, 'fr'));
    const comptes = [...new Set(a.alertes.map(x => x.compte))].sort((x, y) => x.localeCompare(y, 'fr'));
    const actions = [...new Set(a.alertes.flatMap(x => x.actions))].sort((x, y) => x.localeCompare(y, 'fr'));
    const filtres = [
      { cle: 'etat', titre: 'Tous les états', icon: 'toggle_on', items: [{ value: '', label: 'Tous les états' }, { value: 'actif', label: 'Actives' }, { value: 'inactif', label: 'Désactivées' }, { value: 'anomalie', label: 'Avec anomalie (haute / moyenne)' }], test: (x, v) => (v === 'actif' ? x.actif : v === 'inactif' ? !x.actif : x.anomalies.some(y => y.priorite < 3)) },
      { cle: 'declencheur', titre: 'Tous les déclencheurs', icon: 'bolt', items: [{ value: '', label: 'Tous les déclencheurs' }, ...declencheurs.map(d => ({ value: d, label: d }))], test: (x, v) => x.declencheur === v },
      { cle: 'action', titre: 'Toutes les actions', icon: 'send', items: [{ value: '', label: 'Toutes les actions' }, ...actions.map(d => ({ value: d, label: d }))], test: (x, v) => x.actions.includes(v) },
      { cle: 'compte', titre: 'Tous les comptes', icon: 'account_tree', items: [{ value: '', label: 'Tous les comptes' }, ...comptes.map(c => ({ value: c, label: c }))], test: (x, v) => x.compte === v }
    ];
    filtresCourants.alertes = filtres;
    const lignes = filtrer('alertes', a.alertes, x => `${x.nom} ${x.compte} ${x.client} ${x.declencheur} ${(x.emails || []).join(' ')} ${(x.telephones || []).join(' ')} ${x.nomsUnites.join(' ')}`, filtres);
    const colonnes = [
      { id: 'nom', titre: 'Alerte', tri: x => x.nom, html: x => `<div class="aud-nom">${esc(x.nom)}</div><div class="aud-sous">${esc(x.ressource)}</div>` },
      { id: 'etat', titre: 'État', tri: x => (x.actif ? 1 : 0), html: x => (x.actif ? badge('Active', 'ok', 'notifications_active') : badge('Désactivée', 'gris', 'notifications_off')) },
      { id: 'declencheur', titre: 'Déclencheur', tri: x => x.declencheur, html: x => esc(x.declencheur) },
      { id: 'client', titre: 'Client', tri: x => x.client, html: x => esc(x.client) },
      { id: 'unites', titre: 'Véhicules', num: true, tri: x => x.unites, html: x => `${nombre(x.unites)}${x.groupes ? ` <span class="aud-muted" title="Groupes surveillés">· ${nombre(x.groupes)} gr.</span>` : ''}` },
      { id: 'actions', titre: 'Actions', tri: x => x.actions.join(','), html: x => x.actions.map(t => `<span class="aud-puce">${esc(t)}</span>`).join(' ') },
      { id: 'dest', titre: 'Destinataires', tri: x => (x.emails || []).length + (x.telephones || []).length, html: x => listeCourte(x.emails && x.telephones ? [...x.emails, ...x.telephones] : x.emails) },
      { id: 'declenchements', titre: 'Déclenchements', num: true, tri: x => x.declenchements, aide: 'Compteur Wialon depuis la création', html: x => nombre(x.declenchements) },
      { id: 'modifie', titre: 'Modifiée le', tri: x => x.modifie, html: x => esc(jour(x.modifie)) },
      { id: 'anomalies', titre: 'Anomalies', tri: x => (x.anomalies.length ? 10 - Math.min(...x.anomalies.map(y => y.priorite)) : 0), html: x => badgesAnomalies(x.anomalies) }
    ];
    return `${barre('alertes', 'Rechercher une alerte, un véhicule, un destinataire…', filtres)}
      ${tableau('alertes', colonnes, lignes, { triDefaut: { col: 'anomalies', sens: -1 }, clic: true })}`;
  }

  function vueAnomalies() {
    const a = vue.analyse;
    const categories = [...new Set(a.anomalies.map(x => x.categorie))];
    const filtres = [
      { cle: 'priorite', titre: 'Toutes les priorités', icon: 'priority_high', items: [{ value: '', label: 'Toutes les priorités' }, { value: '1', label: 'Haute' }, { value: '2', label: 'Moyenne' }, { value: '3', label: 'Basse' }], test: (x, v) => String(x.priorite) === String(v) },
      { cle: 'categorie', titre: 'Toutes les catégories', icon: 'category', items: [{ value: '', label: 'Toutes les catégories' }, ...categories.map(c => ({ value: c, label: c }))], test: (x, v) => x.categorie === v }
    ];
    filtresCourants.anomalies = filtres;
    const lignes = filtrer('anomalies', a.anomalies, x => `${x.objet} ${x.client} ${x.compte} ${x.texte}`, filtres);
    const colonnes = [
      { id: 'priorite', titre: 'Priorité', tri: x => x.priorite, html: x => badgePriorite(x.priorite) },
      { id: 'categorie', titre: 'Catégorie', tri: x => x.categorie, html: x => esc(x.categorie) },
      { id: 'objet', titre: 'Élément', tri: x => x.objet, html: x => `<div class="aud-nom">${esc(x.objet)}</div>${x.compte ? `<div class="aud-sous">${esc(x.compte)}</div>` : ''}` },
      { id: 'client', titre: 'Client', tri: x => x.client, html: x => esc(x.client) },
      { id: 'texte', titre: 'Détail', tri: x => x.texte, html: x => esc(x.texte) }
    ];
    return `${barre('anomalies', 'Rechercher une anomalie, un client…', filtres)}
      ${tableau('anomalies', colonnes, lignes, { triDefaut: { col: 'priorite', sens: 1 }, clic: true })}`;
  }

  const THEMES_JOURNAL = [
    { value: 'alerte', label: 'Alertes', re: /notification/i },
    { value: 'rapport', label: 'Rapports et tâches', re: /report|job|rapport/i },
    { value: 'acces', label: 'Utilisateurs et droits', re: /user|access|password|right/i },
    { value: 'unite', label: 'Véhicules', re: /unit|device/i },
    { value: 'zone', label: 'Zones et points d\'intérêt', re: /geofence|zone|poi/i }
  ];

  function vueJournal() {
    if (vue.journalChargement) {
      const p = vue.journalChargement;
      return `<section class="aud-carte aud-chargement-carte"><h3>Lecture du journal des modifications…</h3>
        <div class="aud-progression"><span id="aud-journal-barre" style="width:${Math.round(100 * p.part)}%"></span></div>
        <p id="aud-journal-message" class="aud-muted">${esc(p.message)}</p></section>`;
    }
    if (!vue.journal) {
      return `<section class="aud-carte aud-chargement-carte">
        <h3>Journal des modifications (90 derniers jours)</h3>
        <p>Qui a créé, modifié ou supprimé une alerte, un rapport planifié, un utilisateur ou un véhicule, et les SMS consommés par compte.
        La lecture exécute un rapport Wialon par ressource (environ une minute).</p>
        <button type="button" class="adm-btn primary" data-aud-action="journal"><span class="ms">history</span> Charger le journal des modifications</button>
      </section>`;
    }
    const res = new Map(vue.brut.ressources.map(r => [r.id, r.nom]));
    const lignesBrutes = vue.journal.lignes.map(l => ({ ...l, ressource: res.get(l.ressourceId) || '' }));
    const utilisateurs = [...new Set(lignesBrutes.map(l => l.utilisateur))].sort((a, b) => a.localeCompare(b, 'fr'));
    const filtres = [
      { cle: 'theme', titre: 'Tous les thèmes', icon: 'category', items: [{ value: '', label: 'Tous les thèmes' }, ...THEMES_JOURNAL.map(t => ({ value: t.value, label: t.label }))], test: (l, v) => THEMES_JOURNAL.find(t => t.value === v).re.test(l.action) },
      { cle: 'utilisateur', titre: 'Tous les utilisateurs', icon: 'person', items: [{ value: '', label: 'Tous les utilisateurs' }, ...utilisateurs.map(u => ({ value: u, label: u }))], test: (l, v) => l.utilisateur === v }
    ];
    filtresCourants.journal = filtres;
    const lignes = filtrer('journal', lignesBrutes, l => `${l.ressource} ${l.utilisateur} ${l.action} ${l.ip}`, filtres);
    const colonnes = [
      { id: 't', titre: 'Date', tri: l => l.t, html: l => esc(date(l.t)) },
      { id: 'ressource', titre: 'Ressource', tri: l => l.ressource, html: l => esc(l.ressource) },
      { id: 'utilisateur', titre: 'Utilisateur', tri: l => l.utilisateur, html: l => esc(l.utilisateur) },
      { id: 'action', titre: 'Action', tri: l => l.action, html: l => esc(l.action) },
      { id: 'ip', titre: 'Adresse IP', tri: l => l.ip, html: l => esc(l.ip) }
    ];
    const smsParRessource = new Map();
    for (const s of vue.journal.sms) smsParRessource.set(s.ressourceId, (smsParRessource.get(s.ressourceId) || 0) + (s.nombre || 1));
    const sms = [...smsParRessource].map(([id, n]) => ({ libelle: res.get(id) || `#${id}`, valeur: n })).sort((a, b) => b.valeur - a.valeur);
    return `
      ${barre('journal', 'Rechercher une action, un utilisateur, une ressource…', filtres, `<span class="aud-muted">Lu le ${esc(date(vue.journal.fin))}</span>`)}
      ${tableau('journal', colonnes, lignes, { triDefaut: { col: 't', sens: -1 } })}
      <section class="aud-carte">
        <header><h3>SMS envoyés par ressource</h3><p>${esc(String(vue.journal.jours))} derniers jours · SMS des alertes et des rapports.</p></header>
        ${barresListe(sms.slice(0, 15), { suffixe: ' SMS' })}
      </section>`;
  }

  // ── Tiroir de détail ───────────────────────────────────────────────────────
  function ligneInfo(libelle, valeur) {
    return `<div class="aud-info-ligne"><span>${esc(libelle)}</span><strong>${valeur}</strong></div>`;
  }
  function sectionAnomalies(liste) {
    if (!liste || !liste.length) return '';
    return `<div class="adm-section"><div class="adm-section-title"><span class="ms">report</span> Anomalies</div>
      ${liste.map(x => `<div class="aud-anom">${badgePriorite(x.priorite)} ${esc(x.texte)}</div>`).join('')}</div>`;
  }
  function miniMois(mois) {
    const cles = Object.keys(mois).sort();
    if (!cles.length) return '<div class="aud-muted">Aucune session sur la période</div>';
    return colonnesMois(cles.map(k => ({ mois: k, sessions: mois[k], utilisateurs: 1 })));
  }

  function contenuTiroir() {
    const a = vue.analyse;
    const t = vue.tiroir;
    if (t.type === 'client') {
      const c = a.clients.find(x => x.nom === t.nom);
      if (!c) return null;
      const users = a.utilisateurs.filter(u => u.client === c.nom);
      const alertes = a.alertes.filter(x => x.client === c.nom);
      const taches = a.taches.filter(x => x.client === c.nom);
      const mois = {};
      for (const u of users) for (const [k, n] of Object.entries(u.mois)) mois[k] = (mois[k] || 0) + n;
      return {
        titre: c.nom,
        sous: `${c.type} · ${nombre(c.vehicules)} véhicules (${nombre(c.vehiculesActifs)} actifs)`,
        corps: `
          <div class="adm-section"><div class="adm-section-title"><span class="ms">insights</span> Utilisation · ${esc(periodeCourante().court)}</div>
            ${ligneInfo('Utilisateurs actifs 30 j / total', `${nombre(c.actifs30)} / ${nombre(c.utilisateurs)}`)}
            ${ligneInfo('Sessions', nombre(c.sessions))}
            ${ligneInfo('Temps connecté', duree(c.duree))}
            ${ligneInfo('Dernière connexion', `${esc(date(c.derniere))} · ${esc(relatif(c.derniere))}`)}
            ${miniMois(mois)}
          </div>
          ${sectionAnomalies(c.anomalies)}
          <div class="adm-section"><div class="adm-section-title"><span class="ms">group</span> Utilisateurs (${users.length})</div>
            ${users.map(u => `<div class="aud-info-ligne aud-clic" data-aud-aller="utilisateur:${esc(u.nom)}"><span>${esc(u.nom)}<br><small class="aud-muted">${esc(u.appPrincipale || '—')} · ${nombre(u.sessions)} sessions</small></span>${badgeStatut(u.statut, u.supprime)}</div>`).join('') || '<div class="aud-muted">Aucun utilisateur rattaché</div>'}
          </div>
          <div class="adm-section"><div class="adm-section-title"><span class="ms">schedule_send</span> Rapports planifiés (${taches.length})</div>
            ${taches.map(x => `<div class="aud-info-ligne aud-clic" data-aud-aller="tache:${x.ressourceId}:${x.id}"><span>${esc(x.nom)}<br><small class="aud-muted">${esc(x.periodicite)} · ${nombre(x.envois)} envois · dernier ${esc(relatif(x.dernierEnvoi))}</small></span>${x.actif ? badge('Actif', 'ok') : badge('Désactivé', 'gris')}</div>`).join('') || '<div class="aud-muted">Aucun rapport planifié</div>'}
          </div>
          <div class="adm-section"><div class="adm-section-title"><span class="ms">notifications_active</span> Alertes (${alertes.length})</div>
            ${alertes.map(x => `<div class="aud-info-ligne aud-clic" data-aud-aller="alerte:${x.ressourceId}:${x.id}"><span>${esc(x.nom)}<br><small class="aud-muted">${esc(x.declencheur)} · ${esc(x.actions.join(', '))} · ${nombre(x.declenchements)} décl.</small></span>${x.actif ? badge('Active', 'ok') : badge('Désactivée', 'gris')}</div>`).join('') || '<div class="aud-muted">Aucune alerte</div>'}
          </div>`
      };
    }
    if (t.type === 'utilisateur') {
      const u = a.utilisateurs.find(x => x.nom === t.nom);
      if (!u) return null;
      const familles = Object.entries(u.familles).sort((x, y) => y[1] - x[1]).map(([f, n]) => ({ libelle: f, valeur: n }));
      return {
        titre: u.nom,
        sous: `${u.type} · ${u.client} · compte ${u.compte}`,
        corps: `
          <div class="adm-section"><div class="adm-section-title"><span class="ms">person</span> Connexions</div>
            ${ligneInfo('Statut', badgeStatut(u.statut, u.supprime))}
            ${ligneInfo('Première connexion', esc(date(u.premiere)))}
            ${ligneInfo('Dernière connexion', `${esc(date(u.derniere))} · ${esc(relatif(u.derniere))}`)}
            ${ligneInfo(`Sessions (${periodeCourante().court})`, `${nombre(u.sessions)} <span class="aud-muted">/ ${nombre(u.sessionsTotal)} au total</span>`)}
            ${ligneInfo('Temps connecté · session médiane', `${duree(u.duree)} · ${duree(u.dureeMediane)}`)}
            ${ligneInfo('Jours actifs', nombre(u.joursActifs))}
            ${ligneInfo('Adresses IP distinctes', nombre(u.ips))}
            ${ligneInfo('Véhicules visibles', nombre(u.vehicules))}
            ${u.role ? ligneInfo('Rôle (admin)', esc(u.role)) : ''}
          </div>
          <div class="adm-section"><div class="adm-section-title"><span class="ms">calendar_month</span> Sessions par mois</div>${miniMois(u.mois)}</div>
          <div class="adm-section"><div class="adm-section-title"><span class="ms">devices</span> Applications</div>${barresListe(familles, { suffixe: ' sessions' })}
            <div class="aud-muted">Principale : ${esc(u.appPrincipale || '—')}</div></div>
          ${u.client && u.client !== 'Interne' && a.clients.some(c => c.nom === u.client) ? `<button type="button" class="adm-btn" data-aud-aller="client:${esc(u.client)}"><span class="ms">business</span> Voir le client ${esc(u.client)}</button>` : ''}`
      };
    }
    if (t.type === 'alerte') {
      const x = a.alertes.find(y => y.ressourceId === t.ressourceId && y.id === t.id);
      if (!x) return null;
      return {
        titre: x.nom,
        sous: `${x.declencheur} · ${x.ressource} (${x.compte})`,
        corps: `
          ${sectionAnomalies(x.anomalies)}
          <div class="adm-section"><div class="adm-section-title"><span class="ms">notifications_active</span> Configuration</div>
            ${ligneInfo('État', x.actif ? badge('Active', 'ok') : badge('Désactivée', 'gris'))}
            ${ligneInfo('Client', esc(x.client))}
            ${ligneInfo('Déclenchement', x.chaqueMessage ? 'à chaque message' : 'au premier message')}
            ${ligneInfo('Actions', esc(x.actions.join(', ') || '—'))}
            ${ligneInfo('E-mails', listeCourte(x.emails, 10))}
            ${ligneInfo('Téléphones (SMS)', listeCourte(x.telephones, 10))}
            ${ligneInfo('Déclenchements (cumul)', nombre(x.declenchements))}
            ${ligneInfo('Créée · modifiée', `${esc(jour(x.cree))} · ${esc(jour(x.modifie))}`)}
            ${x.expiration ? ligneInfo('Fin', esc(date(x.expiration))) : ''}
          </div>
          ${x.texte ? `<div class="adm-section"><div class="adm-section-title"><span class="ms">sms</span> Texte</div><div class="aud-texte">${esc(x.texte)}</div></div>` : ''}
          <div class="adm-section"><div class="adm-section-title"><span class="ms">directions_car</span> Véhicules surveillés (${x.unites}${x.groupes ? ` · ${x.groupes} groupe(s)` : ''})</div>
            <div class="aud-puces">${x.nomsUnites.map(n => `<span class="aud-puce">${esc(n)}</span>`).join(' ') || '<span class="aud-muted">Aucun</span>'}</div></div>`
      };
    }
    if (t.type === 'tache') {
      const x = a.taches.find(y => y.ressourceId === t.ressourceId && y.id === t.id);
      if (!x) return null;
      return {
        titre: x.nom,
        sous: `${x.type} · ${x.ressource} (${x.compte})`,
        corps: `
          ${sectionAnomalies(x.anomalies)}
          <div class="adm-section"><div class="adm-section-title"><span class="ms">schedule_send</span> Configuration</div>
            ${ligneInfo('État', x.actif ? badge('Actif', 'ok') : badge('Désactivé', 'gris'))}
            ${ligneInfo('Client', esc(x.client))}
            ${ligneInfo('Modèle', esc(x.modele || '—'))}
            ${ligneInfo('Périodicité', esc(x.periodicite))}
            ${x.formats ? ligneInfo('Formats', esc(x.formats)) : ''}
            ${x.periodeFixe ? ligneInfo('Période figée', `${esc(jour(x.periodeFixe.de))} → ${esc(jour(x.periodeFixe.a))}`) : ''}
            ${ligneInfo('E-mails', listeCourte(x.emails, 12))}
            ${x.telephones && x.telephones.length ? ligneInfo('Téléphones', listeCourte(x.telephones, 6)) : ''}
            ${ligneInfo('Envois (cumul)', nombre(x.envois))}
            ${ligneInfo('Dernier envoi', `${esc(date(x.dernierEnvoi))} · ${esc(relatif(x.dernierEnvoi))}`)}
            ${ligneInfo('Créé le', esc(jour(x.cree)))}
          </div>
          <div class="adm-section"><div class="adm-section-title"><span class="ms">directions_car</span> Objets du rapport (${x.objets.length} · ${x.unites} véhicules)</div>
            <div class="aud-puces">${x.objets.map(n => `<span class="aud-puce">${esc(n)}</span>`).join(' ') || '<span class="aud-muted">Aucun</span>'}</div></div>`
      };
    }
    return null;
  }

  function tiroirHtml() {
    if (!vue.tiroir) return '';
    const c = contenuTiroir();
    if (!c) { vue.tiroir = null; return ''; }
    return `
      <div class="adm-drawer-backdrop" data-aud-action="fermer">
        <aside class="adm-drawer aud-tiroir" data-aud-stop>
          <div class="adm-drawer-head">
            <div><h2>${esc(c.titre)}</h2><div class="aud-sous">${esc(c.sous)}</div></div>
            <button type="button" class="adm-btn ghost" data-aud-action="fermer" title="Fermer"><span class="ms">close</span></button>
          </div>
          <div class="adm-drawer-body">${c.corps}</div>
        </aside>
      </div>`;
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────
  function enTete() {
    const a = vue.analyse;
    const compte = (id) => {
      if (id === 'clients') return a.clients.length;
      if (id === 'utilisateurs') return a.utilisateurs.length;
      if (id === 'rapports') return a.taches.length;
      if (id === 'alertes') return a.alertes.length;
      if (id === 'anomalies') return a.synthese.anomalies.haute + a.synthese.anomalies.moyenne;
      return null;
    };
    return `
      <div class="aud-entete">
        <div class="adm-tabs aud-onglets">
          ${ONGLETS.map(o => {
            const n = compte(o.id);
            return `<button type="button" class="adm-tab ${vue.onglet === o.id ? 'active' : ''}" data-aud-onglet="${o.id}"><span class="ms">${o.icon}</span> ${esc(o.libelle)}${n != null ? ` <span class="count">${nombre(n)}</span>` : ''}</button>`;
          }).join('')}
        </div>
        <div class="aud-actions">
          <button type="button" class="notion-modal-dropdown-trigger aud-trigger" data-aud-action="periode" title="Période des indicateurs de connexion">
            <span class="ms">date_range</span><span class="aud-trigger-label">${esc(periodeCourante().libelle)}</span><span class="ms">arrow_drop_down</span>
          </button>
          <button type="button" class="adm-btn" data-aud-action="export" ${vue.export ? 'disabled' : ''}><span class="ms">${vue.export ? 'hourglass_top' : 'download'}</span> ${vue.export ? 'Export en cours…' : 'Exporter Excel'}</button>
          <button type="button" class="adm-btn ghost" data-aud-action="actualiser" title="Relire toutes les données sur Igeo"><span class="ms">refresh</span></button>
        </div>
      </div>
      <div class="aud-meta">Audit de <strong>${esc(vue.compte)}</strong> · ${nombre(a.synthese.sessionsTotal)} sessions lues depuis le ${esc(jour(vue.brut.connexions.depuis))} · données du ${esc(date(vue.brut.genereLe))}</div>`;
  }

  function corps() {
    if (vue.statut === 'chargement' || vue.statut === 'vide') {
      const p = vue.progression;
      return `<section class="aud-carte aud-chargement-carte">
        <h3>Audit de la plateforme Igeo en cours…</h3>
        <p>Lecture des alertes, rapports planifiés et modèles de toutes les ressources, puis du journal de connexion complet (environ 100 000 sessions, 15 Mo). Comptez 15 à 60 secondes.</p>
        <div class="aud-progression"><span id="aud-barre" style="width:${Math.round(100 * p.part)}%"></span></div>
        <p id="aud-message" class="aud-muted">${esc(p.message || 'Démarrage…')}</p>
      </section>`;
    }
    if (vue.statut === 'erreur') {
      return `<section class="aud-carte aud-chargement-carte">
        <h3>L'audit n'a pas pu être chargé</h3>
        <p class="aud-erreur">${esc(vue.erreur)}</p>
        <button type="button" class="adm-btn primary" data-aud-action="actualiser"><span class="ms">refresh</span> Réessayer</button>
      </section>`;
    }
    filtresCourants = {};
    const vues = { synthese: vueSynthese, clients: vueClients, utilisateurs: vueUtilisateurs, rapports: vueRapports, alertes: vueAlertes, anomalies: vueAnomalies, journal: vueJournal };
    return `${enTete()}${(vues[vue.onglet] || vueSynthese)()}`;
  }

  function majProgression() {
    const barre = document.getElementById(vue.journalChargement ? 'aud-journal-barre' : 'aud-barre');
    const msg = document.getElementById(vue.journalChargement ? 'aud-journal-message' : 'aud-message');
    const p = vue.journalChargement || vue.progression;
    if (barre) barre.style.width = `${Math.round(100 * p.part)}%`;
    if (msg) msg.textContent = p.message;
  }

  function visible() {
    return slotEl && document.body.contains(slotEl) && ctx && ctx.state.activeTab === 'audit';
  }

  function dessiner() {
    if (!visible()) return;
    const actif = document.activeElement;
    const cleRecherche = actif && actif.getAttribute && actif.getAttribute('data-aud-recherche');
    const curseur = cleRecherche ? actif.selectionStart : 0;
    slotEl.innerHTML = `<div class="aud-root">${corps()}${vue.statut === 'pret' ? tiroirHtml() : ''}</div>`;
    if (cleRecherche) {
      const input = slotEl.querySelector(`[data-aud-recherche="${cleRecherche}"]`);
      if (input) { input.focus(); input.setSelectionRange(curseur, curseur); }
    }
  }

  // ── Événements (délégués sur le conteneur) ─────────────────────────────────
  function ouvrirMenu(bouton, { titre, items, valeur, onSelect }) {
    window.openNotionDropdown(bouton, { title: titre, items, value: valeur, onSelect, showSearch: items.length > 6, placeholder: 'Rechercher…', minWidth: '240px' });
  }

  function aller(cible) {
    const [type, ...reste] = String(cible).split(':');
    const v = reste.join(':');
    if (type === 'onglet') { vue.onglet = v; vue.tiroir = null; }
    else if (type === 'anomalies') { vue.onglet = 'anomalies'; vue.filtres.anomalies = { priorite: v }; }
    else if (type === 'statut') { vue.onglet = 'utilisateurs'; vue.filtres.utilisateurs = { statut: v, type: '' }; }
    else if (type === 'famille') { vue.onglet = 'utilisateurs'; vue.filtres.utilisateurs = { famille: v }; }
    else if (type === 'client') vue.tiroir = { type: 'client', nom: v };
    else if (type === 'utilisateur') vue.tiroir = { type: 'utilisateur', nom: v };
    else if (type === 'alerte' || type === 'tache') {
      const [ressourceId, id] = v.split(':').map(Number);
      vue.tiroir = { type, ressourceId, id };
    }
    dessiner();
  }

  function ouvrirLigne(table, ligne) {
    if (!ligne) return;
    if (table === 'clients' || table === 'topClients') aller(`client:${ligne.nom}`);
    else if (table === 'utilisateurs') aller(`utilisateur:${ligne.nom}`);
    else if (table === 'rapports') aller(`tache:${ligne.ressourceId}:${ligne.id}`);
    else if (table === 'alertes') aller(`alerte:${ligne.ressourceId}:${ligne.id}`);
    else if (table === 'anomalies') {
      const r = ligne.ref || {};
      if (r.type === 'client') aller(`client:${r.nom}`);
      else if (r.type === 'utilisateur') aller(`utilisateur:${r.nom}`);
      else if (r.type === 'alerte' || r.type === 'tache') aller(`${r.type}:${r.ressourceId}:${r.id}`);
    }
  }

  function surClic(e) {
    const el = e.target.closest('[data-aud-onglet],[data-aud-action],[data-aud-tri],[data-aud-plus],[data-aud-filtre],[data-aud-aller],[data-aud-ligne],[data-aud-stop]');
    if (!el || !slotEl.contains(el)) return;
    if (el.hasAttribute('data-aud-stop') && !e.target.closest('[data-aud-action],[data-aud-aller],[data-aud-onglet]')) return;
    if (el.hasAttribute('data-aud-onglet')) {
      vue.onglet = el.getAttribute('data-aud-onglet');
      dessiner();
      return;
    }
    if (el.hasAttribute('data-aud-action')) {
      const action = el.getAttribute('data-aud-action');
      if (action === 'fermer') { if (e.target === el || el.tagName === 'BUTTON') { vue.tiroir = null; dessiner(); } return; }
      if (action === 'actualiser') { charger(); return; }
      if (action === 'export') { exporterExcel(); return; }
      if (action === 'journal') { chargerJournal(); return; }
      if (action === 'periode') {
        ouvrirMenu(el, {
          titre: 'Période des connexions',
          items: PERIODES.map(p => ({ value: p.id, label: p.libelle, icon: 'date_range' })),
          valeur: vue.periode,
          onSelect: (v) => { vue.periode = v; recalculer(); dessiner(); }
        });
      }
      return;
    }
    if (el.hasAttribute('data-aud-tri')) {
      const [table, col] = el.getAttribute('data-aud-tri').split(':');
      const actuel = vue.tri[table] || {};
      vue.tri[table] = { col, sens: actuel.col === col ? -actuel.sens : -1 };
      dessiner();
      return;
    }
    if (el.hasAttribute('data-aud-plus')) {
      const table = el.getAttribute('data-aud-plus');
      vue.limites[table] = (vue.limites[table] || LIMITE_PAGE) + LIMITE_PAGE;
      dessiner();
      return;
    }
    if (el.hasAttribute('data-aud-filtre')) {
      const [table, cle] = el.getAttribute('data-aud-filtre').split(':');
      const f = (filtresCourants[table] || []).find(x => x.cle === cle);
      if (!f) return;
      ouvrirMenu(el, {
        titre: f.titre,
        items: f.items,
        valeur: (vue.filtres[table] || {})[cle] ?? '',
        onSelect: (v) => {
          vue.filtres[table] = { ...(vue.filtres[table] || {}), [cle]: v };
          vue.limites[table] = LIMITE_PAGE;
          dessiner();
        }
      });
      return;
    }
    if (el.hasAttribute('data-aud-aller')) { aller(el.getAttribute('data-aud-aller')); return; }
    if (el.hasAttribute('data-aud-ligne')) {
      const [table, i] = el.getAttribute('data-aud-ligne').split(':');
      ouvrirLigne(table, (vue.lignesVisibles[table] || [])[Number(i)]);
    }
  }

  let minuteurRecherche = null;
  function surSaisie(e) {
    const cle = e.target.getAttribute && e.target.getAttribute('data-aud-recherche');
    if (!cle) return;
    vue.recherche[cle] = e.target.value;
    vue.limites[cle] = LIMITE_PAGE;
    clearTimeout(minuteurRecherche);
    minuteurRecherche = setTimeout(dessiner, 160);
  }

  // Échap ferme le tiroir, même quand le focus est sur la page (écouteur du document).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && vue.tiroir && visible() && !document.querySelector('.notion-dropdown-menu')) {
      vue.tiroir = null;
      dessiner();
    }
  });

  function surTouche(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-aud-ligne],[data-aud-aller]')) {
      e.preventDefault();
      e.target.click();
    }
  }

  // Infobulle unique (valeur d'abord) pour les barres, cellules et colonnes.
  let infobulle = null;
  function montrerInfobulle(cible, x, y) {
    if (!infobulle) {
      infobulle = document.createElement('div');
      infobulle.className = 'aud-infobulle';
      document.body.appendChild(infobulle);
    }
    const lignes = String(cible.getAttribute('data-tip') || '').split('\n');
    infobulle.replaceChildren();
    lignes.forEach((l, i) => {
      const d = document.createElement('div');
      d.textContent = l;
      if (i === 1) d.className = 'aud-infobulle-valeur';
      infobulle.appendChild(d);
    });
    infobulle.style.display = 'block';
    const box = infobulle.getBoundingClientRect();
    const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, x + 12));
    const top = y - box.height - 12 < 8 ? y + 16 : y - box.height - 12;
    infobulle.style.left = `${left}px`;
    infobulle.style.top = `${top}px`;
  }
  const cacherInfobulle = () => { if (infobulle) infobulle.style.display = 'none'; };

  function brancher(slot) {
    if (slot._audBranche) return;
    slot._audBranche = true;
    slot.addEventListener('click', surClic);
    slot.addEventListener('input', surSaisie);
    slot.addEventListener('keydown', surTouche);
    slot.addEventListener('pointermove', (e) => {
      const c = e.target.closest && e.target.closest('[data-tip]');
      if (c && slot.contains(c)) montrerInfobulle(c, e.clientX, e.clientY);
      else cacherInfobulle();
    });
    slot.addEventListener('pointerleave', cacherInfobulle);
    slot.addEventListener('focusin', (e) => {
      const c = e.target.closest && e.target.closest('[data-tip]');
      if (!c) return;
      const r = c.getBoundingClientRect();
      montrerInfobulle(c, r.left + r.width / 2, r.top);
    });
    slot.addEventListener('focusout', cacherInfobulle);
  }

  /** Point d'entrée appelé par app.js quand l'onglet « Audit » est actif. */
  function render(slot, contexte) {
    ctx = contexte;
    slotEl = slot;
    brancher(slot);
    // Autre session (déconnexion puis connexion d'un autre compte) : l'audit en mémoire n'est plus valable.
    const nomSession = (ctx.state.session && ctx.state.session.userName) || '';
    if (vue.sessionNom !== nomSession && vue.statut !== 'chargement') {
      Object.assign(vue, { statut: 'vide', brut: null, analyse: null, journal: null, tiroir: null, sources: null, signature: '', sessionNom: nomSession });
    }
    if (vue.statut === 'vide') { charger(); return; }
    reprendreReglagesAdmin();
    dessiner();
  }

  window.AuditView = { render };
})();
