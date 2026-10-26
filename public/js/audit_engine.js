/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUDIT DE LA PLATEFORME IGEO (track.igeo.africa) — onglet « Audit »
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lecture seule. Rassemble :
 *  - les modèles de rapports (rep), rapports planifiés (ujb) et alertes (unf) de toutes les ressources ;
 *  - le journal de connexion : tableau Wialon « Logins » (account_logins) exécuté sur le compte de la
 *    session, regroupé par utilisateur avec une sous-ligne par session (t1 connexion, t2 déconnexion) ;
 *  - les droits des utilisateurs sur les véhicules (core/check_accessors), pour rattacher chaque
 *    utilisateur à son client.
 * Wialon ne journalise pas les exécutions manuelles de rapports : les rapports « utilisés » sont ceux
 * envoyés par les rapports planifiés (nombre d'envois, dernier envoi).
 *
 * Les fonctions collecter*() appellent l'API (IgeoApi dans le navigateur, adaptateur Node dans
 * scripts/audit_smoke.mjs). analyser() et les fonctions de classement sont pures
 * (tests/audit_engine.test.mjs).
 */
(function (root) {
  const JOUR = 86400;
  const DECALAGE_BENIN = 3600; // Africa/Porto-Novo = UTC+1, sans heure d'été
  const DEBUT_HISTORIQUE = Date.UTC(2025, 0, 1) / 1000; // le journal Igeo commence le 28/01/2025
  const DUREE_MAX_SESSION = JOUR; // une session restée ouverte (application mobile) compte au plus 24 h
  const SOUS_LIGNES_PAR_APPEL = 6000;

  const RES_FLAGS = 0x1 | 0x4 | 0x200 | 0x400 | 0x2000; // base, compte (bact/bpact), tâches ujb, alertes unf, modèles rep
  const UNIT_FLAGS = 0x1 | 0x4 | 0x100; // base, compte, propriétés avancées (act : unité activée)
  const ACL_VOIR = 0x1;

  const STATUTS = ['Actif (7 j)', 'Actif (30 j)', 'Dormant (30–90 j)', 'Inactif (> 90 j)', 'Jamais connecté'];
  const PRIORITES = { 1: 'Haute', 2: 'Moyenne', 3: 'Basse' };
  const INTERNE = /@bourjon\.com$|^@|^3d\s*tech|^3dt\b|^demo/i;

  const maintenant = () => Math.floor(Date.now() / 1000);
  const GC = () => root.GroupeClient;

  // ── Libellés ───────────────────────────────────────────────────────────────
  const APPS_WIALON = {
    gapp_fleetrun: 'Fleetrun',
    gapp_eco_driving: 'Eco Driving',
    gapp_chatter_box: 'Chatterbox',
    gapp_logistics: 'Logistics',
    gapp_dashboard_app: 'Dashboard',
    gapp_sensolator: 'Sensolator'
  };

  /** Application d'une session à partir du champ « site » du journal Wialon. */
  function classerSite(site) {
    const brut = String(site || '').trim();
    const s = brut.toLowerCase();
    if (!s) return { famille: 'Inconnue', libelle: 'Inconnue' };
    if (s.startsWith('mwca.')) {
      if (s.includes('wiatag')) return { famille: 'Android', libelle: 'WiaTag (Android)' };
      return { famille: 'Android', libelle: s.includes('igeo') ? 'App Igeo (Android)' : 'App Wialon Local (Android)' };
    }
    if (s.startsWith('mwci.')) return { famille: 'iOS', libelle: 'App Wialon Local (iOS)' };
    if (s.startsWith('gapp_')) return { famille: 'Apps Wialon', libelle: APPS_WIALON[s] || brut.slice(5) };
    if (/\slocator$/.test(s)) return { famille: 'Locator', libelle: 'Locator (lien de suivi)' };
    const web = s.startsWith('web/') ? s.slice(4).replace(/\.$/, '') : null;
    if (web !== null) {
      if (web.startsWith('cms.')) return { famille: 'CMS', libelle: `CMS ${web}` };
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(web)) return { famille: 'Web', libelle: 'Web (adresse IP)' };
      return { famille: 'Web', libelle: `Web ${web}` };
    }
    if (s.startsWith('cms.')) return { famille: 'CMS', libelle: `CMS ${s}` };
    return { famille: 'API / jeton', libelle: `API / jeton (${brut})` };
  }

  const DECLENCHEURS = {
    geozone: 'Zone',
    speed: 'Vitesse',
    sensor_value: 'Valeur de capteur',
    msg_param: 'Paramètre du message',
    digital_input: 'Entrée numérique',
    outage: 'Perte de connexion',
    fuel_filling: 'Remplissage carburant',
    fuel_theft: 'Vol de carburant',
    service_intervals: 'Maintenance',
    health_check: 'Contrôle de santé',
    driver: 'Conducteur',
    sms: 'SMS reçu',
    alarm: 'Alarme (SOS)',
    interposition: 'Proximité d\'unités',
    passengers: 'Passagers',
    route_control: 'Contrôle d\'itinéraire',
    trailer: 'Remorque',
    tracking: 'Suivi',
    unit_state: 'État de l\'unité'
  };
  const EXPRESSIONS = {
    geozone_inside: 'Entrée de zone',
    geozone_outside: 'Sortie de zone',
    idling: 'Stationnement prolongé',
    speed: 'Excès de vitesse',
    outage: 'Perte de connexion'
  };

  function libelleDeclencheur(trg, expression) {
    const t = trg && typeof trg === 'object' ? trg.t : trg;
    if (expression && EXPRESSIONS[expression]) return EXPRESSIONS[expression];
    return DECLENCHEURS[t] || String(t || '—');
  }

  const ACTIONS = {
    email: 'E-mail',
    sms: 'SMS',
    message: 'Popup',
    event: 'Événement',
    mobile_apps: 'Push mobile',
    push_messages: 'Push navigateur',
    group_manipulation: 'Groupe d\'unités',
    exec_cmd: 'Commande',
    create_task: 'Tâche',
    request_report: 'Rapport',
    email_report: 'Rapport par e-mail',
    counter: 'Compteur',
    store_counter: 'Compteur',
    reset_counter: 'Compteur',
    user_access: 'Droits d\'accès',
    driver_reset: 'Conducteur',
    trailer_reset: 'Remorque',
    route_control: 'Itinéraire'
  };
  const libelleAction = (t) => ACTIONS[t] || String(t || '');

  const decouper = (s) => String(s || '').split(/[;,\s]+/).map(x => x.trim()).filter(Boolean);

  function normaliserActions(act) {
    return (Array.isArray(act) ? act : []).map(a => (typeof a === 'string' ? { t: a, p: null } : { t: a && a.t, p: (a && a.p) || {} }));
  }

  /** E-mails et téléphones des actions d'une alerte ; null si le détail des actions n'est pas lu. */
  function destinataires(actions) {
    if (actions.some(a => a.p === null)) return null;
    const emails = new Set();
    const telephones = new Set();
    for (const a of actions) {
      if (a.p.email_to) decouper(a.p.email_to).forEach(x => emails.add(x));
      if (a.p.phones) decouper(a.p.phones).forEach(x => telephones.add(x));
      if (a.p.phone_to) decouper(a.p.phone_to).forEach(x => telephones.add(x));
    }
    return { emails: [...emails], telephones: [...telephones] };
  }

  const TYPES_OBJETS = {
    avl_unit: 'Unité',
    avl_unit_group: 'Groupe d\'unités',
    avl_resource: 'Ressource',
    storage_user: 'Utilisateur',
    user: 'Utilisateur',
    avl_driver: 'Conducteur',
    avl_drivers_group: 'Groupe de conducteurs',
    avl_route: 'Itinéraire',
    avl_retranslator: 'Retransmetteur',
    avl_geozone: 'Zone',
    avl_geozones_group: 'Groupe de zones',
    avl_tag: 'Passager',
    avl_trailer: 'Remorque'
  };

  const TYPES_TACHES = {
    send_email_report: 'Rapport par e-mail',
    send_email_sms_fuel: 'Carburant par e-mail / SMS',
    reset_unit_bytes_counter: 'Remise à zéro trafic GPRS',
    reset_unit_mileage_counter: 'Remise à zéro kilométrage',
    reset_unit_engine_hours_counter: 'Remise à zéro heures moteur',
    exec_unit_cmd: 'Commande',
    change_unit_access: 'Droits d\'accès'
  };

  const FORMATS = [[1, 'HTML'], [2, 'PDF'], [4, 'XLS'], [8, 'XLSX'], [16, 'XML'], [32, 'CSV']];
  const libelleFormats = (fileType) => {
    const n = Number(fileType) || 0;
    return FORMATS.filter(([bit]) => n & bit).map(([, nom]) => nom).join(' + ');
  };

  /** Périodicité d'un rapport planifié : « r » = « 1 HH:MM » (chaque jour à heure fixe) ou « 2 <secondes> ». */
  function periodiciteTache(job) {
    const [mode, valeur] = String((job && job.r) || '').trim().split(/\s+/);
    // Calendrier sch : m = jours du mois (bit 0 = le 1er), w = jours de la semaine (bit 0 = lundi), y = mois.
    const sch = (job && job.sch) || {};
    const joursMois = Number(sch.m) || 0;
    const joursSemaine = Number(sch.w) || 0;
    const moisAnnee = Number(sch.y) || 0;
    if (mode === '1') {
      const [h, m] = String(valeur || '0').split(':');
      const heure = `${String(Number(h) || 0).padStart(2, '0')}:${String(Number(m) || 0).padStart(2, '0')}`;
      if (moisAnnee) return { libelle: `Certains mois à ${heure}`, secondes: 366 * JOUR };
      if (joursMois) {
        const jours = [];
        for (let b = 0; b < 31; b++) if (joursMois & (2 ** b)) jours.push(b + 1);
        const libelle = jours.length === 1 ? `Le ${jours[0] === 1 ? '1er' : jours[0]} du mois à ${heure}` : `Les ${jours.join(', ')} du mois à ${heure}`;
        return { libelle, secondes: 31 * JOUR };
      }
      if (joursSemaine) {
        const noms = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].filter((_n, b) => joursSemaine & (2 ** b));
        return { libelle: `Chaque ${noms.join(', ')} à ${heure}`, secondes: 7 * JOUR };
      }
      return { libelle: `Chaque jour à ${heure}`, secondes: JOUR };
    }
    if (mode === '2') {
      const sec = Number(valeur) || 0;
      const noms = { 3600: 'Toutes les heures', 86400: 'Chaque jour', 604800: 'Chaque semaine', 1209600: 'Toutes les 2 semaines', 2592000: 'Tous les 30 jours' };
      const libelle = noms[sec] || (sec >= JOUR ? `Tous les ${Math.round(sec / JOUR)} jours` : `Toutes les ${Math.round(sec / 3600)} h`);
      return { libelle, secondes: sec };
    }
    return { libelle: String((job && job.r) || '—'), secondes: 0 };
  }

  function statutConnexion(derniere, now) {
    if (!derniere) return STATUTS[4];
    const age = now - derniere;
    if (age <= 7 * JOUR) return STATUTS[0];
    if (age <= 30 * JOUR) return STATUTS[1];
    if (age <= 90 * JOUR) return STATUTS[2];
    return STATUTS[3];
  }

  // Date locale (Bénin) d'un instant Unix : clés de jour et de mois, jour de semaine (lundi = 0) et heure.
  function decomposer(t) {
    const d = new Date((t + DECALAGE_BENIN) * 1000);
    const mois = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { jour: `${mois}-${String(d.getUTCDate()).padStart(2, '0')}`, mois, semaine: (d.getUTCDay() + 6) % 7, heure: d.getUTCHours() };
  }

  const mediane = (valeurs) => {
    if (!valeurs.length) return 0;
    const v = valeurs.slice().sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  const plusFrequent = (map) => {
    let meilleur = '';
    let n = -1;
    for (const [k, v] of map) if (v > n) { meilleur = k; n = v; }
    return meilleur;
  };

  // ── Collecte (API Wialon, lecture seule) ───────────────────────────────────
  const recherche = (itemsType, flags) => ({
    svc: 'core/search_items',
    params: { spec: { itemsType, propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' }, force: 1, flags, from: 0, to: 0 }
  });

  const paquets = (liste, n) => {
    const out = [];
    for (let i = 0; i < liste.length; i += n) out.push(liste.slice(i, i + n));
    return out;
  };

  /** Ressources, véhicules (activés ou non), alertes, rapports planifiés et modèles (avec leur détail). */
  async function collecterConfiguration(api, { onProgress } = {}) {
    if (onProgress) onProgress('Lecture des ressources, alertes, rapports planifiés et modèles…', 0.02);
    const [resRes, unitRes] = await api.batch([recherche('avl_resource', RES_FLAGS), recherche('avl_unit', UNIT_FLAGS)]);
    if (!resRes || resRes.error) throw new Error(`Lecture des ressources impossible (erreur ${resRes ? resRes.error : '?'})`);

    const ressources = (resRes.items || []).map(r => ({
      id: Number(r.id),
      nom: r.nm || `Ressource #${r.id}`,
      compteId: Number(r.bact || r.id),
      compteParentId: Number(r.bpact || 0),
      createurId: Number(r.crt || 0),
      unf: r.unf || {},
      ujb: r.ujb || {},
      rep: r.rep || {}
    }));
    const unites = ((unitRes && unitRes.items) || []).map(u => ({ id: Number(u.id), nom: u.nm, compteId: Number(u.bact || 0), active: u.act !== 0 }));

    const appels = [];
    const cibles = [];
    for (const r of ressources) {
      const ajouter = (svc, resume, type) => {
        const ids = Object.keys(resume).map(Number);
        if (!ids.length) return;
        appels.push({ svc, params: { itemId: r.id, col: ids, flags: 0 } });
        cibles.push({ r, type, resume });
      };
      ajouter('resource/get_notification_data', r.unf, 'alertes');
      ajouter('resource/get_job_data', r.ujb, 'taches');
      ajouter('report/get_report_data', r.rep, 'modeles');
    }
    if (onProgress) onProgress(`Détail de ${appels.length} listes d'alertes, de rapports planifiés et de modèles…`, 0.06);
    const reponses = await api.batchChunked(appels);

    const out = { alertes: [], taches: [], modeles: [] };
    reponses.forEach((liste, i) => {
      const { r, type, resume } = cibles[i];
      // Détail refusé (droits) : on garde le résumé de la recherche, sans destinataires.
      const elements = Array.isArray(liste) ? liste : Object.values(resume);
      for (const el of elements) if (el && typeof el === 'object') out[type].push({ ...el, ressourceId: r.id, detail: Array.isArray(liste) });
    });

    return {
      ressources: ressources.map(({ unf: _a, ujb: _b, rep: _c, ...r }) => r),
      unites,
      ...out
    };
  }

  /** { unitId: [userId…] } : utilisateurs qui voient chaque véhicule. */
  async function collecterAcces(api, unitIds) {
    const acces = {};
    const reponses = await api.batchChunked(paquets(unitIds, 100).map(items => ({ svc: 'core/check_accessors', params: { items, flags: 1 } })));
    for (const r of reponses) {
      if (!r || typeof r !== 'object' || r.error) continue;
      for (const [unitId, users] of Object.entries(r)) {
        acces[unitId] = Object.entries(users || {})
          .filter(([, a]) => a && (Number(a.acl) & ACL_VOIR))
          .map(([userId]) => Number(userId));
      }
    }
    return acces;
  }

  function modeleConnexions() {
    const sch = { f1: 0, f2: 0, t1: 0, t2: 0, m: 0, y: 0, w: 0 };
    return {
      n: 'Audit · Connexions',
      ct: 'avl_resource',
      p: '',
      tbl: [{
        n: 'account_logins', l: 'Connexions', c: 'host,site', cl: 'host,site', cp: '', s: '', sl: '',
        // Regroupement par utilisateur + flag 0x100 (détail) : une sous-ligne par session.
        p: JSON.stringify({ grouping: JSON.stringify({ type: 'user', nested: 0 }) }),
        sch,
        f: 0x110
      }]
    };
  }

  /**
   * Journal de connexion de tout le compte : { utilisateurs: [{nom, premiere, derniere, nbSessions}],
   * sessions: [[indexUtilisateur, t1, t2, ip, site]…] }.
   */
  async function collecterConnexions(api, compteId, { depuis = DEBUT_HISTORIQUE, jusqua = maintenant(), onProgress } = {}) {
    const nettoyer = () => api.call('report/cleanup_result', {}).catch(() => {});
    await nettoyer();
    try {
      if (onProgress) onProgress('Exécution du journal de connexion sur Igeo…', 0);
      const exec = await api.call('report/exec_report', {
        reportResourceId: compteId,
        reportTemplateId: 0,
        reportTemplate: modeleConnexions(),
        reportObjectId: compteId,
        reportObjectSecId: 0,
        interval: { from: depuis, to: jusqua, flags: 0 }
      });
      const table = exec && exec.reportResult && (exec.reportResult.tables || [])[0];
      if (!table || !table.rows) return { utilisateurs: [], sessions: [], depuis, jusqua };

      const lignes = await api.call('report/select_result_rows', { tableIndex: 0, config: { type: 'range', data: { from: 0, to: table.rows - 1, level: 0 } } });
      const utilisateurs = (lignes || []).map(l => ({ nom: String(l.c[0]), premiere: l.t1, derniere: l.t2, nbSessions: l.d || 0 }));

      const sessions = [];
      let i = 0;
      while (i < lignes.length) {
        let j = i;
        let cumul = 0;
        while (j < lignes.length && (j === i || cumul + (lignes[j].d || 0) <= SOUS_LIGNES_PAR_APPEL)) {
          cumul += lignes[j].d || 0;
          j++;
        }
        const paquet = await api.call('report/select_result_rows', { tableIndex: 0, config: { type: 'range', data: { from: i, to: j - 1, level: 1 } } });
        (paquet || []).forEach((l, k) => {
          for (const s of l.r || []) sessions.push([i + k, s.t1, s.t2, String(s.c[1] || ''), String(s.c[2] || '')]);
        });
        i = j;
        if (onProgress) onProgress(`Journal de connexion : ${sessions.length.toLocaleString('fr-FR')} sessions lues…`, i / lignes.length);
      }
      return { utilisateurs, sessions, depuis, jusqua };
    } finally {
      await nettoyer();
    }
  }

  function modeleJournal() {
    const sch = { f1: 0, f2: 0, t1: 0, t2: 0, m: 0, y: 0, w: 0 };
    const table = (n, c) => ({ n, l: n, c, cl: c, cp: '', s: '', sl: '', p: '', sch, f: 0x10 });
    return {
      n: 'Audit · Journal',
      ct: 'avl_resource',
      p: '',
      tbl: [table('resource_log', 'time,user,item_type,action,host'), table('resource_sms_stat', 'time,user,phone,spent_count,count')]
    };
  }

  /** Journal des modifications et SMS consommés de chaque ressource sur les derniers jours (une exécution par ressource). */
  async function collecterJournal(api, ressources, { jours = 90, onProgress } = {}) {
    const fin = maintenant();
    const debut = fin - jours * JOUR;
    const lignes = [];
    const sms = [];
    const nettoyer = () => api.call('report/cleanup_result', {}).catch(() => {});
    for (const [k, r] of ressources.entries()) {
      if (onProgress) onProgress(`Journal des modifications : ${r.nom} (${k + 1}/${ressources.length})`, k / ressources.length);
      try {
        await nettoyer();
        const exec = await api.call('report/exec_report', {
          reportResourceId: r.id,
          reportTemplateId: 0,
          reportTemplate: modeleJournal(),
          reportObjectId: r.id,
          reportObjectSecId: 0,
          interval: { from: debut, to: fin, flags: 0 }
        });
        const tables = (exec && exec.reportResult && exec.reportResult.tables) || [];
        for (const [ti, t] of tables.entries()) {
          if (!t.rows) continue;
          const rows = await api.call('report/select_result_rows', { tableIndex: ti, config: { type: 'range', data: { from: 0, to: Math.min(t.rows, 3000) - 1, level: 0 } } });
          for (const l of rows || []) {
            const c = l.c || [];
            if (t.name === 'resource_log') {
              lignes.push({ ressourceId: r.id, t: l.t1, utilisateur: String(c[1] || ''), type: String(c[2] || ''), action: String(c[3] || ''), ip: String(c[4] || '') });
            } else if (t.name === 'resource_sms_stat') {
              sms.push({ ressourceId: r.id, t: l.t1, utilisateur: String(c[1] || ''), telephone: String(c[2] || ''), credits: Number(c[3]) || 0, nombre: Number(c[4]) || 0 });
            }
          }
        }
      } catch (_e) {
        // Ressource sans droit de lecture du journal : ignorée.
      }
    }
    await nettoyer();
    return { jours, debut, fin, lignes, sms };
  }

  // ── Analyse (pure) ─────────────────────────────────────────────────────────
  /**
   * brut = { genereLe, compteRacineId, ressources, unites:[{id, nom, compteId, active, clientField}],
   *          groupes:[{id, name, unitIds, multiClient, clientSpa}], utilisateurs:[{id, nom, compteId, role}],
   *          acces, alertes, taches, modeles, connexions }
   * opts = { depuis (début de la période, Unix), maintenant }
   */
  function analyser(brut, opts = {}) {
    const now = opts.maintenant || brut.genereLe || maintenant();
    const depuis = opts.depuis || 0;
    const ressources = brut.ressources || [];
    const resParId = new Map(ressources.map(r => [r.id, r]));

    // Comptes : ressources dont le compte de facturation est elles-mêmes.
    const comptes = new Map();
    for (const r of ressources) if (r.compteId === r.id) comptes.set(r.id, { id: r.id, nom: r.nom, parentId: r.compteParentId, createurId: r.createurId });
    // Compte de revendeur / partenaire (3DS TOGO, IGEO, TRACKING BOA…) : parent d'autres comptes, ou
    // compte qui héberge les ressources et les utilisateurs de plusieurs clients.
    const comptesParents = new Set();
    for (const c of comptes.values()) if (c.parentId && c.parentId !== c.id) comptesParents.add(c.parentId);
    const ressourcesParCompte = new Map();
    for (const r of ressources) if (r.compteId !== r.id) ressourcesParCompte.set(r.compteId, (ressourcesParCompte.get(r.compteId) || 0) + 1);
    const utilisateursParCompte = new Map();
    for (const u of brut.utilisateurs || []) utilisateursParCompte.set(u.compteId, (utilisateursParCompte.get(u.compteId) || 0) + 1);
    const racineId = Number(brut.compteRacineId) || 0;
    const compteRevendeur = (id) => comptesParents.has(id) || ((ressourcesParCompte.get(id) || 0) >= 2 && (utilisateursParCompte.get(id) || 0) >= 3);
    const nomCompte = (id) => (comptes.get(id) || {}).nom || (id ? `Compte #${id}` : '—');
    const compteDedie = (id) => !!id && comptes.has(id) && !compteRevendeur(id) && id !== racineId;

    // Véhicules → client (règle « Groupe / Client » des rapports, repli sur le compte dédié).
    const groupes = brut.groupes || [];
    const gc = GC();
    const exclus = gc ? gc.excludedGroupIds(groupes) : new Set();
    const unites = (brut.unites || []).map(u => {
      const client = (gc ? gc.clientLabel(u, groupes, exclus) : '') || String(u.clientField || '').trim() || (compteDedie(u.compteId) ? nomCompte(u.compteId) : '');
      return { ...u, client };
    });
    const uniteParId = new Map(unites.map(u => [u.id, u]));
    const groupeParId = new Map(groupes.map(g => [Number(g.id), g]));
    // Véhicules d'une liste d'objets (véhicules et groupes), sans doublon.
    const unitesDeObjets = (ids) => {
      const out = new Map();
      for (const id of ids) {
        if (uniteParId.has(id)) out.set(id, uniteParId.get(id));
        else if (groupeParId.has(id)) for (const uid of groupeParId.get(id).unitIds || []) if (uniteParId.has(Number(uid))) out.set(Number(uid), uniteParId.get(Number(uid)));
      }
      return [...out.values()];
    };
    const clientMajoritaire = (listeUnites) => {
      const comptage = new Map();
      for (const u of listeUnites) if (u && u.client) comptage.set(u.client, (comptage.get(u.client) || 0) + 1);
      return plusFrequent(comptage);
    };

    // Utilisateurs (avec ceux vus dans le journal puis supprimés).
    const connexions = brut.connexions || { utilisateurs: [], sessions: [] };
    const base = (brut.utilisateurs || []).map(u => ({ ...u }));
    const parNom = new Map(base.map(u => [u.nom, u]));
    for (const j of connexions.utilisateurs) {
      if (!parNom.has(j.nom)) {
        const u = { id: null, nom: j.nom, compteId: 0, role: '', supprime: true };
        base.push(u);
        parNom.set(j.nom, u);
      }
    }
    const unitesParUtilisateur = new Map();
    for (const [unitId, users] of Object.entries(brut.acces || {})) {
      for (const userId of users) {
        if (!unitesParUtilisateur.has(userId)) unitesParUtilisateur.set(userId, []);
        unitesParUtilisateur.get(userId).push(Number(unitId));
      }
    }
    const nbUnites = unites.length || 1;

    // Sessions : historique complet (dernière connexion) et période choisie (indicateurs).
    const nomsJournal = connexions.utilisateurs.map(x => x.nom);
    const cacheSites = new Map();
    const classer = (site) => {
      let c = cacheSites.get(site);
      if (!c) { c = classerSite(site); cacheSites.set(site, c); }
      return c;
    };
    const acc = new Map();
    const accDe = (nom) => {
      let a = acc.get(nom);
      if (!a) {
        a = { premiere: 0, derniere: 0, total: 0, sessions: 0, duree: 0, durees: [], jours: new Set(), familles: new Map(), libelles: new Map(), ips: new Set(), ips30: new Set(), mois: new Map() };
        acc.set(nom, a);
      }
      return a;
    };
    for (const [idx, t1] of connexions.sessions) {
      const a = accDe(nomsJournal[idx]);
      a.total++;
      if (!a.premiere || t1 < a.premiere) a.premiere = t1;
      if (t1 > a.derniere) a.derniere = t1;
    }
    for (const j of connexions.utilisateurs) {
      // Sessions non détaillées : bornes de la ligne de regroupement.
      const a = accDe(j.nom);
      if (!a.total) { a.premiere = j.premiere; a.derniere = j.derniere; a.total = j.nbSessions; }
    }

    // Type d'utilisateur choisi dans admin.igeopilot (Utilisateurs & Rôles) : Technicien et Support sont
    // des comptes internes, même dans le compte d'un client (identifiants support3d…, compte principal).
    const typeDe = (u) => {
      if (INTERNE.test(u.nom) || u.role === 'Technicien' || u.role === 'Support') return 'Interne';
      const compte = comptes.get(u.compteId);
      if (u.id && compte && compte.createurId === u.id && compteRevendeur(compte.id) && compte.id !== racineId) return 'Revendeur';
      return 'Client';
    };
    // Client d'un utilisateur : celui de la majorité de ses véhicules (même nom que la colonne « Client »
    // des véhicules), sinon son compte dédié ; un revendeur reste rattaché à son propre compte.
    const clientDe = (u, type) => {
      if (type === 'Interne') return 'Interne';
      if (type === 'Revendeur') return nomCompte(u.compteId);
      const ids = (u.id && unitesParUtilisateur.get(u.id)) || [];
      const comptage = new Map();
      for (const id of ids) {
        const c = (uniteParId.get(id) || {}).client;
        if (c) comptage.set(c, (comptage.get(c) || 0) + 1);
      }
      if (!comptage.size) return compteDedie(u.compteId) ? nomCompte(u.compteId) : 'Non rattaché';
      const tri = [...comptage].sort((a, b) => b[1] - a[1]);
      if (tri.length === 1 || tri[0][1] / ids.length >= 0.6) return tri[0][0];
      return `Multi-clients (${tri.length})`;
    };

    const infosUtilisateur = new Map();
    for (const u of base) {
      const type = typeDe(u);
      infosUtilisateur.set(u.nom, { type, client: clientDe(u, type) });
    }

    // Agrégats de la période (sessions de clients, hors API, pour les graphiques).
    const parMois = new Map();
    const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const familles = new Map();
    const applications = new Map();
    const il30 = now - 30 * JOUR;
    for (const [idx, t1, t2, ip, site] of connexions.sessions) {
      if (t1 < depuis) continue;
      const nom = nomsJournal[idx];
      const a = accDe(nom);
      const app = classer(site);
      const duree = Math.max(0, Math.min((t2 || t1) - t1, DUREE_MAX_SESSION));
      const d = decomposer(t1);
      a.sessions++;
      a.duree += duree;
      a.durees.push(duree);
      a.jours.add(d.jour);
      a.familles.set(app.famille, (a.familles.get(app.famille) || 0) + 1);
      a.libelles.set(app.libelle, (a.libelles.get(app.libelle) || 0) + 1);
      a.mois.set(d.mois, (a.mois.get(d.mois) || 0) + 1);
      if (ip) a.ips.add(ip);
      if (ip && t1 >= il30) a.ips30.add(ip);

      const info = infosUtilisateur.get(nom) || { type: 'Client' };
      const appKey = app.libelle;
      if (!applications.has(appKey)) applications.set(appKey, { libelle: app.libelle, famille: app.famille, sessions: 0, utilisateurs: new Set(), clients: new Set(), duree: 0 });
      const ap = applications.get(appKey);
      ap.sessions++;
      ap.duree += duree;
      ap.utilisateurs.add(nom);
      if (info.type !== 'Interne') ap.clients.add(nom);

      if (info.type === 'Interne' || app.famille === 'API / jeton') continue;
      if (!parMois.has(d.mois)) parMois.set(d.mois, { mois: d.mois, sessions: 0, utilisateurs: new Set() });
      const pm = parMois.get(d.mois);
      pm.sessions++;
      pm.utilisateurs.add(nom);
      heatmap[d.semaine][d.heure]++;
      if (!familles.has(app.famille)) familles.set(app.famille, { famille: app.famille, sessions: 0, utilisateurs: new Set() });
      const fa = familles.get(app.famille);
      fa.sessions++;
      fa.utilisateurs.add(nom);
    }

    const utilisateurs = base.map(u => {
      const a = acc.get(u.nom) || accDe(u.nom);
      const info = infosUtilisateur.get(u.nom);
      const vehicules = u.id ? (unitesParUtilisateur.get(u.id) || []).length : 0;
      return {
        id: u.id,
        nom: u.nom,
        compteId: u.compteId,
        compte: nomCompte(u.compteId),
        role: u.role || '',
        supprime: !!u.supprime,
        type: info.type,
        client: info.client,
        vehicules,
        statut: statutConnexion(a.derniere, now),
        premiere: a.premiere || 0,
        derniere: a.derniere || 0,
        joursDepuis: a.derniere ? Math.floor((now - a.derniere) / JOUR) : null,
        sessionsTotal: a.total,
        sessions: a.sessions,
        duree: a.duree,
        dureeMediane: mediane(a.durees),
        joursActifs: a.jours.size,
        appPrincipale: plusFrequent(a.libelles),
        famillePrincipale: plusFrequent(a.familles),
        familles: Object.fromEntries(a.familles),
        ips: a.ips.size,
        ips30: a.ips30.size,
        mois: Object.fromEntries(a.mois)
      };
    }).sort((x, y) => y.sessions - x.sessions || y.derniere - x.derniere);

    // ── Alertes ──
    const signatures = new Map();
    const alertes = (brut.alertes || []).map(n => {
      const res = resParId.get(n.ressourceId) || {};
      // « un » contient des véhicules et/ou des groupes de véhicules.
      const un = (n.un || []).map(Number);
      const connues = unitesDeObjets(un);
      const groupesSurveilles = un.filter(id => groupeParId.has(id)).length;
      const inactives = connues.filter(x => !x.active).length;
      const inconnues = un.filter(id => !uniteParId.has(id) && !groupeParId.has(id)).length;
      const actions = normaliserActions(n.act);
      const dest = destinataires(actions);
      const trg = n.trg && typeof n.trg === 'object' ? n.trg : { t: n.trg, p: n.trg_p || {} };
      const actif = !(Number(n.fl) & 2);
      const sig = JSON.stringify([trg.t, n.expression || '', n.conditions || trg.p || {}, un.slice().sort((a, b) => a - b), actions.map(a => a.t).sort()]);
      if (actif) signatures.set(sig, (signatures.get(sig) || 0) + 1);
      return {
        id: n.id,
        ressourceId: n.ressourceId,
        ressource: res.nom || '',
        compte: nomCompte(res.compteId),
        nom: n.n || `Alerte #${n.id}`,
        texte: n.txt || '',
        declencheur: libelleDeclencheur(trg, n.expression),
        declencheurType: trg.t || '',
        actif,
        chaqueMessage: !!(Number(n.fl) & 1),
        unites: connues.length,
        groupes: groupesSurveilles,
        objetsInconnus: inconnues,
        unitesInactives: inactives,
        nomsUnites: connues.map(x => x.nom),
        client: clientMajoritaire(connues) || nomCompte(res.compteId),
        actions: actions.map(a => libelleAction(a.t)),
        actionTypes: actions.map(a => a.t),
        emails: dest ? dest.emails : null,
        telephones: dest ? dest.telephones : null,
        declenchements: Number(n.ac) || 0,
        cree: n.ct || 0,
        modifie: n.mt || 0,
        activation: n.ta || 0,
        expiration: n.td || 0,
        _sig: sig,
        anomalies: []
      };
    });
    for (const a of alertes) {
      const p = (prio, texte) => a.anomalies.push({ priorite: prio, texte });
      const doublons = a.actif ? signatures.get(a._sig) || 0 : 0;
      delete a._sig;
      if (!a.actif) { p(3, 'Alerte désactivée'); continue; }
      if (!a.unites) p(1, a.objetsInconnus ? 'Véhicules ou groupes surveillés supprimés' : 'Aucun véhicule surveillé');
      else if (a.unitesInactives === a.unites) p(1, 'Tous les véhicules surveillés sont désactivés');
      else if (a.unitesInactives || a.objetsInconnus) p(2, [a.unitesInactives && `${a.unitesInactives} véhicule(s) désactivé(s)`, a.objetsInconnus && `${a.objetsInconnus} véhicule(s) ou groupe(s) supprimé(s)`].filter(Boolean).join(' · '));
      if (a.emails && a.actionTypes.includes('email') && !a.emails.length) p(1, 'Action e-mail sans destinataire');
      if (a.telephones && a.actionTypes.includes('sms') && !a.telephones.length) p(1, 'Action SMS sans numéro');
      if (!a.actionTypes.some(t => ['email', 'sms', 'mobile_apps', 'push_messages'].includes(t))) p(3, 'Aucune notification envoyée (popup / événement seulement)');
      if (a.expiration && a.expiration < now) p(2, 'Alerte expirée (date de fin dépassée)');
      if (!a.declenchements && a.cree && now - a.cree > 30 * JOUR) p(3, 'Jamais déclenchée');
      if (a.declenchements > 2000) p(3, `Très fréquente (${a.declenchements.toLocaleString('fr-FR')} déclenchements)`);
      if (doublons > 1) p(2, `Doublon possible (${doublons} alertes identiques)`);
    }

    // ── Modèles de rapports et rapports planifiés ──
    const modeleParCle = new Map();
    const modeles = (brut.modeles || []).map(m => {
      const res = resParId.get(m.ressourceId) || {};
      const tables = (m.tbl || []).filter(t => t && !/_stats$/.test(t.n || '')).map(t => t.l || t.n);
      const row = {
        id: m.id,
        ressourceId: m.ressourceId,
        ressource: res.nom || '',
        compte: nomCompte(res.compteId),
        nom: m.n || `Modèle #${m.id}`,
        type: TYPES_OBJETS[m.ct] || m.ct || '',
        tables,
        cree: (m.bsfl && m.bsfl.ct) || 0,
        modifie: (m.bsfl && m.bsfl.mt) || 0,
        taches: 0,
        tachesActives: 0,
        envois: 0
      };
      modeleParCle.set(`${m.ressourceId}:${m.id}`, row);
      return row;
    });

    const nomObjet = (id) => (uniteParId.get(id) || {}).nom || (groupeParId.get(id) || {}).name || `#${id}`;

    const taches = (brut.taches || []).map(j => {
      const res = resParId.get(j.ressourceId) || {};
      const act = j.act && typeof j.act === 'object' ? j.act : { t: j.act, p: null };
      const p = act.p || {};
      const st = j.st || {};
      const per = periodiciteTache(j);
      const modele = act.t === 'send_email_report' && act.p ? modeleParCle.get(`${Number(p.report_guid)}:${Number(p.report_id)}`) : null;
      // Modèle absent de la lecture : supprimé, ou simplement non lisible avec le compte de la session
      // (la tâche continue alors d'envoyer ses rapports).
      const envoiRecent = Number(st.l) > 0 && per.secondes > 0 && now - Number(st.l) <= 2 * per.secondes + 3600;
      const nomRessourceModele = (resParId.get(Number(p.report_guid)) || {}).nom || `ressource ${p.report_guid}`;
      const objets = decouper(p.report_objects || p.units).map(Number).filter(Boolean);
      const unitesObjets = unitesDeObjets(objets);
      const actif = Number(st.e) === 1;
      const row = {
        id: j.id,
        ressourceId: j.ressourceId,
        ressource: res.nom || '',
        compte: nomCompte(res.compteId),
        nom: j.n || `Tâche #${j.id}`,
        type: TYPES_TACHES[act.t] || act.t || '',
        typeCode: act.t || '',
        actif,
        periodicite: per.libelle,
        periodeSec: per.secondes,
        modele: modele ? modele.nom : (act.p && p.report_id ? `Modèle #${p.report_id} · ${nomRessourceModele}${envoiRecent ? ' (non lisible avec ce compte)' : ''}` : ''),
        modeleTrouve: !!modele,
        objets: objets.map(nomObjet),
        unites: unitesObjets.length,
        unitesInactives: unitesObjets.filter(u => !u.active).length,
        client: clientMajoritaire(unitesObjets) || nomCompte(res.compteId),
        emails: act.p ? decouper(p.email_to) : null,
        telephones: act.p ? decouper(p.phone_to) : null,
        formats: libelleFormats(p.file_type),
        periodeFigee: Number(p.time_from) > 1e9 && Number(p.time_to) > 1e9,
        periodeFixe: Number(p.time_from) > 1e9 ? { de: Number(p.time_from), a: Number(p.time_to) } : null,
        envois: Number(st.c) || 0,
        dernierEnvoi: Number(st.l) || 0,
        activation: j.at || 0,
        cree: j.ct || 0,
        modifie: j.mt || 0,
        anomalies: []
      };
      if (modele) {
        modele.taches++;
        if (actif) modele.tachesActives++;
        modele.envois += row.envois;
      }
      const a = (prio, texte) => row.anomalies.push({ priorite: prio, texte });
      if (!actif) a(3, 'Rapport planifié désactivé');
      else {
        const reference = row.dernierEnvoi || row.activation || row.cree;
        if (row.periodeSec && (!row.activation || row.activation <= now) && reference && now - reference > 2 * row.periodeSec + 3600) {
          a(1, row.dernierEnvoi ? 'En retard : pas d\'envoi depuis plus de deux périodes' : 'Jamais envoyé');
        }
        if (act.t === 'send_email_report' && act.p && !modele && !envoiRecent) a(1, 'Modèle de rapport introuvable');
        if (row.emails && !row.emails.length && !(row.telephones && row.telephones.length)) a(1, 'Aucun destinataire');
        if (row.periodeFigee) a(2, 'Période figée : le rapport renvoie toujours les mêmes dates');
        if (objets.length && unitesObjets.length && row.unitesInactives === unitesObjets.length) a(2, 'Tous les véhicules du rapport sont désactivés');
        if (objets.length && !unitesObjets.length && act.t === 'send_email_report') a(2, 'Véhicules ou groupes du rapport introuvables (supprimés ?)');
      }
      return row;
    });

    // ── Clients ──
    const clients = new Map();
    const clientDeNom = (nom) => {
      if (!clients.has(nom)) {
        clients.set(nom, {
          nom, type: 'Client', utilisateurs: 0, actifs7: 0, actifs30: 0, jamais: 0, sessions: 0, duree: 0, derniere: 0,
          vehicules: 0, vehiculesActifs: 0, alertesActives: 0, alertesInactives: 0, rapportsActifs: 0, rapportsInactifs: 0,
          envois: 0, familles: new Map(), listeUtilisateurs: [], anomalies: []
        });
      }
      return clients.get(nom);
    };
    for (const u of utilisateurs) {
      if (u.type === 'Interne') continue;
      const c = clientDeNom(u.client);
      if (u.type === 'Revendeur') c.type = 'Revendeur';
      c.utilisateurs++;
      if (u.statut === STATUTS[0]) c.actifs7++;
      if (u.statut === STATUTS[0] || u.statut === STATUTS[1]) c.actifs30++;
      if (u.statut === STATUTS[4]) c.jamais++;
      c.sessions += u.sessions;
      c.duree += u.duree;
      c.derniere = Math.max(c.derniere, u.derniere);
      for (const [f, n] of Object.entries(u.familles)) c.familles.set(f, (c.familles.get(f) || 0) + n);
      c.listeUtilisateurs.push(u.nom);
    }
    for (const u of unites) {
      if (!u.client) continue;
      const c = clientDeNom(u.client);
      c.vehicules++;
      if (u.active) c.vehiculesActifs++;
    }
    for (const a of alertes) {
      const c = clientDeNom(a.client);
      if (a.actif) c.alertesActives++; else c.alertesInactives++;
    }
    for (const t of taches) {
      const c = clientDeNom(t.client);
      if (t.actif) c.rapportsActifs++; else c.rapportsInactifs++;
      c.envois += t.envois;
    }
    const listeClients = [...clients.values()].map(c => {
      const row = { ...c, appPrincipale: plusFrequent(c.familles), familles: Object.fromEntries(c.familles), statut: statutConnexion(c.derniere, now) };
      if (row.type === 'Client' && row.nom !== 'Non rattaché' && !/^Multi-clients/.test(row.nom)) {
        const a = (prio, texte) => row.anomalies.push({ priorite: prio, texte });
        if (row.vehiculesActifs && !row.utilisateurs) a(2, 'Véhicules actifs mais aucun utilisateur');
        else if (row.vehiculesActifs && !row.derniere) a(2, 'Aucune connexion depuis 01/2025');
        else if (row.vehiculesActifs && now - row.derniere > 90 * JOUR) a(2, `Aucune connexion depuis ${Math.floor((now - row.derniere) / JOUR)} jours`);
        if (row.vehiculesActifs && !row.alertesActives) a(3, 'Aucune alerte active');
        if (row.vehiculesActifs && !row.rapportsActifs) a(3, 'Aucun rapport planifié actif');
      }
      return row;
    }).sort((x, y) => y.sessions - x.sessions || y.vehicules - x.vehicules);

    // ── Anomalies (liste unique, par priorité) ──
    const anomalies = [];
    for (const a of alertes) for (const x of a.anomalies) anomalies.push({ ...x, categorie: 'Alerte', objet: a.nom, compte: a.compte, client: a.client, ref: { type: 'alerte', ressourceId: a.ressourceId, id: a.id } });
    for (const t of taches) for (const x of t.anomalies) anomalies.push({ ...x, categorie: 'Rapport planifié', objet: t.nom, compte: t.compte, client: t.client, ref: { type: 'tache', ressourceId: t.ressourceId, id: t.id } });
    for (const c of listeClients) for (const x of c.anomalies) anomalies.push({ ...x, categorie: 'Client', objet: c.nom, compte: '', client: c.nom, ref: { type: 'client', nom: c.nom } });
    for (const u of utilisateurs) {
      if (u.type !== 'Client' || u.supprime) continue;
      if (u.statut === STATUTS[4]) anomalies.push({ priorite: 3, texte: 'Jamais connecté depuis 01/2025', categorie: 'Utilisateur', objet: u.nom, compte: u.compte, client: u.client, ref: { type: 'utilisateur', nom: u.nom } });
      if (u.vehicules / nbUnites >= 0.5) anomalies.push({ priorite: 1, texte: `Accès à ${u.vehicules} véhicules (${Math.round(100 * u.vehicules / nbUnites)} % du parc) : vérifier les droits`, categorie: 'Utilisateur', objet: u.nom, compte: u.compte, client: u.client, ref: { type: 'utilisateur', nom: u.nom } });
    }
    anomalies.sort((a, b) => a.priorite - b.priorite || a.categorie.localeCompare(b.categorie, 'fr') || a.objet.localeCompare(b.objet, 'fr'));

    // ── Synthèse ──
    const clientsUtilisateurs = utilisateurs.filter(u => u.type !== 'Interne');
    const parStatut = Object.fromEntries(STATUTS.map(s => [s, clientsUtilisateurs.filter(u => u.statut === s && !u.supprime).length]));
    const sessionsClients = clientsUtilisateurs.reduce((s, u) => s + u.sessions, 0);
    const dureeClients = clientsUtilisateurs.reduce((s, u) => s + u.duree, 0);
    const synthese = {
      genereLe: now,
      depuis,
      comptes: comptes.size,
      ressources: ressources.length,
      vehicules: unites.length,
      vehiculesActifs: unites.filter(u => u.active).length,
      utilisateurs: utilisateurs.filter(u => !u.supprime).length,
      parType: {
        Client: utilisateurs.filter(u => u.type === 'Client' && !u.supprime).length,
        Revendeur: utilisateurs.filter(u => u.type === 'Revendeur' && !u.supprime).length,
        Interne: utilisateurs.filter(u => u.type === 'Interne' && !u.supprime).length
      },
      clients: listeClients.filter(c => c.type === 'Client' && c.nom !== 'Non rattaché').length,
      parStatut,
      sessionsTotal: connexions.sessions.length,
      sessionsClients,
      dureeClients,
      dureeMoyenneClients: sessionsClients ? dureeClients / sessionsClients : 0,
      utilisateursPeriode: clientsUtilisateurs.filter(u => u.sessions).length,
      alertes: { total: alertes.length, actives: alertes.filter(a => a.actif).length, inactives: alertes.filter(a => !a.actif).length, declenchements: alertes.reduce((s, a) => s + a.declenchements, 0) },
      taches: { total: taches.length, actives: taches.filter(t => t.actif).length, enRetard: taches.filter(t => t.anomalies.some(x => x.priorite === 1 && /retard|Jamais envoyé/.test(x.texte))).length, envois: taches.reduce((s, t) => s + t.envois, 0) },
      modeles: modeles.length,
      anomalies: { haute: anomalies.filter(a => a.priorite === 1).length, moyenne: anomalies.filter(a => a.priorite === 2).length, basse: anomalies.filter(a => a.priorite === 3).length },
      parMois: [...parMois.values()].sort((a, b) => a.mois.localeCompare(b.mois)).map(m => ({ mois: m.mois, sessions: m.sessions, utilisateurs: m.utilisateurs.size })),
      familles: [...familles.values()].sort((a, b) => b.sessions - a.sessions).map(f => ({ famille: f.famille, sessions: f.sessions, utilisateurs: f.utilisateurs.size })),
      heatmap
    };

    return {
      synthese,
      utilisateurs,
      clients: listeClients,
      alertes,
      taches,
      modeles,
      applications: [...applications.values()].sort((a, b) => b.sessions - a.sessions).map(a => ({ libelle: a.libelle, famille: a.famille, sessions: a.sessions, utilisateurs: a.utilisateurs.size, utilisateursClients: a.clients.size, duree: a.duree })),
      anomalies,
      unites
    };
  }

  /** Sessions détaillées de la période pour l'export (hors API / jeton). */
  function sessionsDetaillees(brut, analyse, depuis = 0) {
    const connexions = brut.connexions || { utilisateurs: [], sessions: [] };
    const infos = new Map(analyse.utilisateurs.map(u => [u.nom, u]));
    const out = [];
    for (const [idx, t1, t2, ip, site] of connexions.sessions) {
      if (t1 < depuis) continue;
      const app = classerSite(site);
      if (app.famille === 'API / jeton') continue;
      const nom = connexions.utilisateurs[idx].nom;
      const u = infos.get(nom) || {};
      out.push({ nom, client: u.client || '', type: u.type || '', debut: t1, fin: t2 || t1, duree: Math.max(0, (t2 || t1) - t1), famille: app.famille, application: app.libelle, ip, site });
    }
    return out.sort((a, b) => b.debut - a.debut);
  }

  /** Données d'entrée de analyser() à partir de l'état chargé par AdminEngine.loadAllData. */
  function preparerBrut({ engine, state, configuration, acces, connexions, compteRacineId, session }) {
    const champ = (key) => state.schema.find(f => f.key === key) || { key, storage: 'aflds', type: key === 'groupe_multi_client' ? 'boolean' : 'text' };
    const champClient = champ('client');
    const champMulti = champ('groupe_multi_client');
    const champSpa = champ('client_spa');
    const actives = new Map((configuration.unites || []).map(u => [u.id, u]));
    return {
      genereLe: maintenant(),
      compteRacineId,
      ressources: configuration.ressources,
      unites: state.units.map(u => {
        const c = actives.get(u.id) || {};
        return { id: u.id, nom: u.name, compteId: c.compteId || 0, active: c.active !== false, clientField: engine.getFieldRawValue(u, champClient) || '' };
      }),
      groupes: state.groups.map(g => ({
        id: g.id,
        name: g.name,
        unitIds: g.unitIds,
        multiClient: engine.parseBoolValue(engine.getFieldRawValue(g, champMulti)),
        clientSpa: engine.getFieldRawValue(g, champSpa) || ''
      })),
      utilisateurs: [
        ...state.users.map(u => ({ id: u.id, nom: u.name, compteId: u.accountId, role: engine.getUserRole(u) })),
        // L'utilisateur de la session n'apparaît pas dans sa propre recherche d'utilisateurs.
        ...(session && session.userName && !state.users.some(u => u.name === session.userName)
          ? [{ id: Number(session.userId) || null, nom: session.userName, compteId: Number(compteRacineId), role: '' }]
          : [])
      ],
      acces,
      alertes: configuration.alertes,
      taches: configuration.taches,
      modeles: configuration.modeles,
      connexions
    };
  }

  const AuditEngine = {
    JOUR,
    DEBUT_HISTORIQUE,
    STATUTS,
    PRIORITES,
    classerSite,
    libelleDeclencheur,
    libelleAction,
    periodiciteTache,
    statutConnexion,
    decomposer,
    destinataires,
    normaliserActions,
    collecterConfiguration,
    collecterAcces,
    collecterConnexions,
    collecterJournal,
    analyser,
    sessionsDetaillees,
    preparerBrut,
    modeleConnexions
  };
  root.AuditEngine = AuditEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = AuditEngine;
})(typeof window !== 'undefined' ? window : globalThis);
