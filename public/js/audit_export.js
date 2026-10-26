/**
 * Export Excel de l'onglet « Audit » : classeur mis en forme comme l'export PR01 de rapports.igeopilot.com
 * (SheetJS 0.18.5 + JSZip + vendor/xlsx_styles.mjs, copie du noyau partagé rapports-noyau/src).
 * Les bibliothèques ne sont chargées qu'au clic sur « Exporter Excel ».
 * Dates en vraies dates Excel (heure du Bénin), durées en [h]:mm.
 */
(function () {
  const chargees = new Map();
  function chargerScript(src) {
    if (!chargees.has(src)) {
      chargees.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
        document.head.appendChild(s);
      }));
    }
    return chargees.get(src);
  }

  const NUIT = '1F3864';
  const BLEU = '2E5395';
  const B = { bordure: true };
  const DEFS = {
    titre: { police: { gras: true, taille: 16, couleur: NUIT } },
    sousTitre: { police: { taille: 10, couleur: '64748B' } },
    section: { police: { gras: true, taille: 12, couleur: 'FFFFFF' }, fond: NUIT, aligne: { h: 'left' } },
    entete: { ...B, police: { gras: true, taille: 10, couleur: 'FFFFFF' }, fond: BLEU, aligne: { h: 'center', retour: true } },
    texte: { ...B },
    texteRetour: { ...B, aligne: { h: 'left', retour: true } },
    texteGras: { ...B, police: { gras: true } },
    texteCentre: { ...B, aligne: { h: 'center' } },
    nombre: { ...B, format: '#,##0', aligne: { h: 'center' } },
    duree: { ...B, format: '[h]:mm', aligne: { h: 'center' } },
    dateHeure: { ...B, format: 'dd/mm/yyyy hh:mm', aligne: { h: 'center' } },
    date: { ...B, format: 'dd/mm/yyyy', aligne: { h: 'center' } },
    pourcent: { ...B, format: '0.0%', aligne: { h: 'center' } },
    kpiLibelle: { ...B, police: { gras: true, couleur: '0F172A' }, fond: 'F1F5F9' },
    kpiValeur: { ...B, police: { gras: true, taille: 12, couleur: NUIT }, aligne: { h: 'center' } },
    kpiDuree: { ...B, police: { gras: true, taille: 12, couleur: NUIT }, format: '[h]:mm', aligne: { h: 'center' } },
    note: { police: { italique: true, couleur: '64748B' }, aligne: { h: 'left', retour: true } },
    ok: { ...B, police: { couleur: '047857' }, aligne: { h: 'center' } },
    ko: { ...B, police: { gras: true, couleur: 'B91C1C' }, aligne: { h: 'center' } },
    gris: { ...B, police: { italique: true, couleur: '64748B' }, aligne: { h: 'center' } },
    prio1: { ...B, police: { gras: true, couleur: 'FFFFFF' }, fond: 'B91C1C', aligne: { h: 'center' } },
    prio2: { ...B, police: { gras: true, couleur: 'FFFFFF' }, fond: 'C2410C', aligne: { h: 'center' } },
    prio3: { ...B, police: { gras: true, couleur: '0F172A' }, fond: 'E2E8F0', aligne: { h: 'center' } }
  };

  const dateExcel = (t) => (t ? { t: 'n', v: (t + 3600) / 86400 + 25569 } : '');
  const duree = (sec) => (Number.isFinite(sec) ? { t: 'n', v: sec / 86400 } : '');
  const liste = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? 'non lu' : String(v));
  const anomaliesTexte = (a) => (a || []).map(x => x.texte).join(' · ');
  const styleStatut = (statut) => (/^Actif/.test(statut) ? 'ok' : /Jamais|Inactif/.test(statut) ? 'ko' : 'texteCentre');

  async function exporter({ brut, analyse, journal, periode, compte }) {
    await chargerScript('vendor/xlsx.full.min.js');
    await chargerScript('vendor/jszip.min.js');
    const X = await import(new URL('vendor/xlsx_styles.mjs', document.baseURI).href);
    const XLSX = window.XLSX;
    const E = window.AuditEngine;
    const wb = XLSX.utils.book_new();
    const feuilles = [];
    const genere = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Porto-Novo' });
    const s = analyse.synthese;

    const enTete = (f, titre, nb) => {
      f.ecrire([titre], 'titre', { hauteur: 26 });
      f.fusionner(0, 0, nb - 1);
      f.ecrire([`Plateforme Igeo (track.igeo.africa) · compte ${compte} · période : ${periode.libelle} · généré le ${genere}`], 'sousTitre');
      f.fusionner(1, 0, nb - 1);
      f.sauter();
    };
    // Tableau filtrable : en-tête + lignes, volet figé sous l'en-tête.
    const tableau = (nom, titre, colonnes, lignes, { couleur } = {}) => {
      const f = X.feuille();
      enTete(f, titre, colonnes.length);
      const ligneEntete = f.ecrire(colonnes.map(c => c.titre), 'entete', { hauteur: 30 });
      for (const l of lignes) f.ecrire(colonnes.map(c => c.val(l)), colonnes.map(c => (typeof c.style === 'function' ? c.style(l) : c.style || 'texte')));
      f.largeurs(colonnes.map(c => c.largeur || 14));
      f.filtre(ligneEntete, colonnes.length, f.ligne - 1);
      XLSX.utils.book_append_sheet(wb, f.terminer(), nom);
      feuilles.push({ nom, carte: f.carte, figerLignes: ligneEntete + 1, couleurOnglet: couleur || BLEU, titres: `$${ligneEntete + 1}:$${ligneEntete + 1}` });
    };

    // ── Synthèse ──
    {
      const f = X.feuille();
      enTete(f, 'Audit de la plateforme Igeo — Synthèse', 4);
      const kpi = (libelle, valeur, style = 'kpiValeur') => f.ecrire([libelle, valeur], ['kpiLibelle', style]);
      const section = (titre) => { f.sauter(); const r = f.ecrire([titre, null, null, null], 'section'); f.fusionner(r, 0, 3); };
      section('Parc et comptes');
      kpi('Comptes', s.comptes);
      kpi('Clients (rattachés par leurs véhicules)', s.clients);
      kpi('Véhicules (actifs)', `${s.vehicules} (${s.vehiculesActifs})`);
      kpi('Utilisateurs', s.utilisateurs);
      kpi('dont clients / revendeurs / internes', `${s.parType.Client} / ${s.parType.Revendeur} / ${s.parType.Interne}`);
      section('Connexions des clients (hors comptes internes)');
      kpi('Sessions sur la période', s.sessionsClients);
      kpi('Utilisateurs connectés sur la période', s.utilisateursPeriode);
      kpi('Temps de connexion cumulé', duree(s.dureeClients), 'kpiDuree');
      kpi('Durée moyenne d\'une session', duree(s.dureeMoyenneClients), 'kpiDuree');
      for (const st of E.STATUTS) kpi(`Utilisateurs « ${st} »`, s.parStatut[st] || 0);
      section('Rapports et alertes');
      kpi('Modèles de rapports', s.modeles);
      kpi('Rapports planifiés (actifs)', `${s.taches.total} (${s.taches.actives})`);
      kpi('Envois de rapports planifiés (cumul Wialon)', s.taches.envois);
      kpi('Rapports planifiés en retard', s.taches.enRetard);
      kpi('Alertes (actives)', `${s.alertes.total} (${s.alertes.actives})`);
      kpi('Déclenchements d\'alertes (cumul Wialon)', s.alertes.declenchements);
      kpi('Anomalies haute / moyenne / basse', `${s.anomalies.haute} / ${s.anomalies.moyenne} / ${s.anomalies.basse}`);

      section('Connexions par mois (clients)');
      f.ecrire(['Mois', 'Sessions', 'Utilisateurs', null], 'entete');
      for (const m of s.parMois) f.ecrire([m.mois, m.sessions, m.utilisateurs, null], ['texteCentre', 'nombre', 'nombre', null]);
      section('Applications utilisées (clients)');
      f.ecrire(['Application', 'Sessions', 'Utilisateurs', 'Part des sessions'], 'entete');
      const totalFam = s.familles.reduce((x, y) => x + y.sessions, 0) || 1;
      for (const fa of s.familles) f.ecrire([fa.famille, fa.sessions, fa.utilisateurs, { t: 'n', v: fa.sessions / totalFam }], ['texte', 'nombre', 'nombre', 'pourcent']);

      f.sauter();
      const n1 = f.ecrire(['Wialon n\'enregistre pas les rapports lancés à la main par les utilisateurs : les rapports « utilisés » sont ceux envoyés par les rapports planifiés (onglet Rapports planifiés, colonnes Envois et Dernier envoi).', null, null, null], 'note', { hauteur: 42 });
      f.fusionner(n1, 0, 3);
      const n2 = f.ecrire(['Durée d\'une session : de la connexion à la déconnexion ou à l\'expiration ; une session restée ouverte (application mobile) compte au plus 24 h. Les connexions par jeton (scripts, rapports.igeopilot.com) sont classées « API / jeton ».', null, null, null], 'note', { hauteur: 42 });
      f.fusionner(n2, 0, 3);
      f.largeurs([46, 18, 14, 16]);
      XLSX.utils.book_append_sheet(wb, f.terminer(), 'Synthèse');
      feuilles.push({ nom: 'Synthèse', carte: f.carte, quadrillage: false, couleurOnglet: NUIT });
    }

    tableau('Clients', 'Clients — utilisation et configuration', [
      { titre: 'Client', val: c => c.nom, style: 'texteGras', largeur: 32 },
      { titre: 'Type', val: c => c.type, style: 'texteCentre', largeur: 11 },
      { titre: 'Utilisateurs', val: c => c.utilisateurs, style: 'nombre', largeur: 11 },
      { titre: 'Actifs 30 j', val: c => c.actifs30, style: 'nombre', largeur: 10 },
      { titre: 'Jamais connectés', val: c => c.jamais, style: 'nombre', largeur: 11 },
      { titre: 'Sessions (période)', val: c => c.sessions, style: 'nombre', largeur: 11 },
      { titre: 'Temps de connexion', val: c => duree(c.duree), style: 'duree', largeur: 12 },
      { titre: 'Dernière connexion', val: c => dateExcel(c.derniere), style: 'dateHeure', largeur: 17 },
      { titre: 'Statut', val: c => c.statut, style: c => styleStatut(c.statut), largeur: 16 },
      { titre: 'Application principale', val: c => c.appPrincipale, style: 'texteCentre', largeur: 16 },
      { titre: 'Véhicules', val: c => c.vehicules, style: 'nombre', largeur: 10 },
      { titre: 'Véhicules actifs', val: c => c.vehiculesActifs, style: 'nombre', largeur: 10 },
      { titre: 'Alertes actives', val: c => c.alertesActives, style: 'nombre', largeur: 10 },
      { titre: 'Alertes désactivées', val: c => c.alertesInactives, style: 'nombre', largeur: 11 },
      { titre: 'Rapports planifiés actifs', val: c => c.rapportsActifs, style: 'nombre', largeur: 11 },
      { titre: 'Envois de rapports', val: c => c.envois, style: 'nombre', largeur: 10 },
      { titre: 'Anomalies', val: c => anomaliesTexte(c.anomalies), style: 'texteRetour', largeur: 44 },
      { titre: 'Utilisateurs (liste)', val: c => c.listeUtilisateurs.join(', '), style: 'texteRetour', largeur: 50 }
    ], analyse.clients);

    tableau('Utilisateurs', 'Utilisateurs — journal de connexion', [
      { titre: 'Utilisateur', val: u => u.nom, style: 'texteGras', largeur: 32 },
      { titre: 'Type', val: u => u.type, style: 'texteCentre', largeur: 10 },
      { titre: 'Client', val: u => u.client, largeur: 26 },
      { titre: 'Compte', val: u => u.compte, largeur: 20 },
      { titre: 'Rôle (admin)', val: u => u.role, style: 'texteCentre', largeur: 11 },
      { titre: 'Statut', val: u => (u.supprime ? 'Supprimé' : u.statut), style: u => (u.supprime ? 'gris' : styleStatut(u.statut)), largeur: 16 },
      { titre: 'Première connexion', val: u => dateExcel(u.premiere), style: 'dateHeure', largeur: 17 },
      { titre: 'Dernière connexion', val: u => dateExcel(u.derniere), style: 'dateHeure', largeur: 17 },
      { titre: 'Jours depuis', val: u => (u.joursDepuis == null ? '' : u.joursDepuis), style: 'nombre', largeur: 9 },
      { titre: 'Sessions (période)', val: u => u.sessions, style: 'nombre', largeur: 10 },
      { titre: 'Sessions (historique)', val: u => u.sessionsTotal, style: 'nombre', largeur: 11 },
      { titre: 'Temps de connexion', val: u => duree(u.duree), style: 'duree', largeur: 11 },
      { titre: 'Durée médiane', val: u => duree(u.dureeMediane), style: 'duree', largeur: 10 },
      { titre: 'Jours actifs', val: u => u.joursActifs, style: 'nombre', largeur: 9 },
      { titre: 'Application principale', val: u => u.appPrincipale, largeur: 26 },
      { titre: 'Web', val: u => u.familles.Web || 0, style: 'nombre', largeur: 8 },
      { titre: 'Android', val: u => u.familles.Android || 0, style: 'nombre', largeur: 8 },
      { titre: 'iOS', val: u => u.familles.iOS || 0, style: 'nombre', largeur: 8 },
      { titre: 'API / jeton', val: u => u.familles['API / jeton'] || 0, style: 'nombre', largeur: 8 },
      { titre: 'Véhicules visibles', val: u => u.vehicules, style: 'nombre', largeur: 9 },
      { titre: 'Adresses IP (période)', val: u => u.ips, style: 'nombre', largeur: 10 }
    ], analyse.utilisateurs);

    const sessions = E.sessionsDetaillees(brut, analyse, periode.depuis);
    tableau('Sessions', `Sessions — ${sessions.length.toLocaleString('fr-FR')} connexions (hors API / jeton)`, [
      { titre: 'Connexion', val: r => dateExcel(r.debut), style: 'dateHeure', largeur: 17 },
      { titre: 'Déconnexion', val: r => dateExcel(r.fin), style: 'dateHeure', largeur: 17 },
      { titre: 'Durée', val: r => duree(r.duree), style: 'duree', largeur: 9 },
      { titre: 'Utilisateur', val: r => r.nom, largeur: 32 },
      { titre: 'Type', val: r => r.type, style: 'texteCentre', largeur: 10 },
      { titre: 'Client', val: r => r.client, largeur: 26 },
      { titre: 'Application', val: r => r.famille, style: 'texteCentre', largeur: 12 },
      { titre: 'Détail', val: r => r.application, largeur: 26 },
      { titre: 'Adresse IP', val: r => r.ip, largeur: 16 }
    ], sessions);

    tableau('Applications', 'Applications et sites de connexion', [
      { titre: 'Application', val: a => a.libelle, style: 'texteGras', largeur: 40 },
      { titre: 'Famille', val: a => a.famille, style: 'texteCentre', largeur: 14 },
      { titre: 'Sessions', val: a => a.sessions, style: 'nombre', largeur: 11 },
      { titre: 'Utilisateurs', val: a => a.utilisateurs, style: 'nombre', largeur: 11 },
      { titre: 'dont clients', val: a => a.utilisateursClients, style: 'nombre', largeur: 11 },
      { titre: 'Temps de connexion', val: a => duree(a.duree), style: 'duree', largeur: 12 }
    ], analyse.applications);

    tableau('Rapports planifiés', 'Rapports planifiés (tâches Wialon)', [
      { titre: 'Rapport planifié', val: t => t.nom, style: 'texteGras', largeur: 36 },
      { titre: 'État', val: t => (t.actif ? 'Actif' : 'Désactivé'), style: t => (t.actif ? 'ok' : 'gris'), largeur: 10 },
      { titre: 'Type', val: t => t.type, largeur: 18 },
      { titre: 'Ressource', val: t => t.ressource, largeur: 20 },
      { titre: 'Compte', val: t => t.compte, largeur: 18 },
      { titre: 'Client', val: t => t.client, largeur: 24 },
      { titre: 'Modèle', val: t => t.modele, largeur: 26 },
      { titre: 'Périodicité', val: t => t.periodicite, largeur: 20 },
      { titre: 'Formats', val: t => t.formats, style: 'texteCentre', largeur: 10 },
      { titre: 'Objets', val: t => t.objets.join(', '), style: 'texteRetour', largeur: 30 },
      { titre: 'Destinataires e-mail', val: t => liste(t.emails), style: 'texteRetour', largeur: 40 },
      { titre: 'Téléphones', val: t => liste(t.telephones), style: 'texteRetour', largeur: 18 },
      { titre: 'Envois', val: t => t.envois, style: 'nombre', largeur: 9 },
      { titre: 'Dernier envoi', val: t => dateExcel(t.dernierEnvoi), style: 'dateHeure', largeur: 17 },
      { titre: 'Créé le', val: t => dateExcel(t.cree), style: 'date', largeur: 12 },
      { titre: 'Anomalies', val: t => anomaliesTexte(t.anomalies), style: 'texteRetour', largeur: 44 }
    ], analyse.taches);

    tableau('Modèles de rapports', 'Modèles de rapports', [
      { titre: 'Modèle', val: m => m.nom, style: 'texteGras', largeur: 36 },
      { titre: 'Ressource', val: m => m.ressource, largeur: 22 },
      { titre: 'Compte', val: m => m.compte, largeur: 18 },
      { titre: 'Objet', val: m => m.type, style: 'texteCentre', largeur: 14 },
      { titre: 'Tableaux', val: m => m.tables.join(', '), style: 'texteRetour', largeur: 50 },
      { titre: 'Rapports planifiés', val: m => m.taches, style: 'nombre', largeur: 10 },
      { titre: 'dont actifs', val: m => m.tachesActives, style: 'nombre', largeur: 9 },
      { titre: 'Envois', val: m => m.envois, style: 'nombre', largeur: 9 },
      { titre: 'Créé le', val: m => dateExcel(m.cree), style: 'date', largeur: 12 },
      { titre: 'Modifié le', val: m => dateExcel(m.modifie), style: 'date', largeur: 12 }
    ], analyse.modeles);

    tableau('Alertes', 'Alertes (notifications Wialon)', [
      { titre: 'Alerte', val: a => a.nom, style: 'texteGras', largeur: 36 },
      { titre: 'État', val: a => (a.actif ? 'Active' : 'Désactivée'), style: a => (a.actif ? 'ok' : 'gris'), largeur: 10 },
      { titre: 'Déclencheur', val: a => a.declencheur, largeur: 20 },
      { titre: 'Ressource', val: a => a.ressource, largeur: 20 },
      { titre: 'Compte', val: a => a.compte, largeur: 18 },
      { titre: 'Client', val: a => a.client, largeur: 24 },
      { titre: 'Véhicules', val: a => a.unites, style: 'nombre', largeur: 9 },
      { titre: 'dont désactivés', val: a => a.unitesInactives, style: 'nombre', largeur: 9 },
      { titre: 'Groupes', val: a => a.groupes, style: 'nombre', largeur: 8 },
      { titre: 'Actions', val: a => a.actions.join(', '), style: 'texteRetour', largeur: 26 },
      { titre: 'Destinataires e-mail', val: a => liste(a.emails), style: 'texteRetour', largeur: 36 },
      { titre: 'Téléphones (SMS)', val: a => liste(a.telephones), style: 'texteRetour', largeur: 20 },
      { titre: 'Déclenchements', val: a => a.declenchements, style: 'nombre', largeur: 11 },
      { titre: 'Créée le', val: a => dateExcel(a.cree), style: 'date', largeur: 12 },
      { titre: 'Modifiée le', val: a => dateExcel(a.modifie), style: 'date', largeur: 12 },
      { titre: 'Fin', val: a => dateExcel(a.expiration), style: 'date', largeur: 12 },
      { titre: 'Texte', val: a => a.texte, style: 'texteRetour', largeur: 50 },
      { titre: 'Anomalies', val: a => anomaliesTexte(a.anomalies), style: 'texteRetour', largeur: 44 }
    ], analyse.alertes);

    tableau('Anomalies', 'Anomalies par priorité', [
      { titre: 'Priorité', val: a => E.PRIORITES[a.priorite], style: a => `prio${a.priorite}`, largeur: 10 },
      { titre: 'Catégorie', val: a => a.categorie, style: 'texteCentre', largeur: 16 },
      { titre: 'Élément', val: a => a.objet, style: 'texteGras', largeur: 36 },
      { titre: 'Client', val: a => a.client, largeur: 26 },
      { titre: 'Compte', val: a => a.compte, largeur: 18 },
      { titre: 'Détail', val: a => a.texte, style: 'texteRetour', largeur: 60 }
    ], analyse.anomalies, { couleur: 'B91C1C' });

    if (journal) {
      const res = new Map((brut.ressources || []).map(r => [r.id, r.nom]));
      tableau('Journal', `Journal des modifications — ${journal.jours} derniers jours`, [
        { titre: 'Date', val: l => dateExcel(l.t), style: 'dateHeure', largeur: 17 },
        { titre: 'Ressource', val: l => res.get(l.ressourceId) || '', largeur: 24 },
        { titre: 'Utilisateur', val: l => l.utilisateur, largeur: 28 },
        { titre: 'Élément', val: l => l.type, style: 'texteCentre', largeur: 14 },
        { titre: 'Action', val: l => l.action, style: 'texteRetour', largeur: 70 },
        { titre: 'Adresse IP', val: l => l.ip, largeur: 16 }
      ], journal.lignes.slice().sort((a, b) => b.t - a.t));
      if (journal.sms.length) {
        tableau('SMS', `SMS envoyés — ${journal.jours} derniers jours`, [
          { titre: 'Date', val: l => dateExcel(l.t), style: 'dateHeure', largeur: 17 },
          { titre: 'Ressource', val: l => res.get(l.ressourceId) || '', largeur: 24 },
          { titre: 'Utilisateur', val: l => l.utilisateur, largeur: 24 },
          { titre: 'Téléphone', val: l => l.telephone, largeur: 18 },
          { titre: 'SMS', val: l => l.nombre, style: 'nombre', largeur: 8 },
          { titre: 'Crédits', val: l => l.credits, style: 'nombre', largeur: 8 }
        ], journal.sms.slice().sort((a, b) => b.t - a.t));
      }
    }

    // finaliser() écrit le zip sans compression : on le recompresse (l'onglet Sessions fait plusieurs Mo).
    const nonCompresse = await X.finaliser(XLSX, window.JSZip, wb, feuilles, DEFS);
    const blob = await (await window.JSZip.loadAsync(nonCompresse)).generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const jour = new Date().toLocaleDateString('fr-CA', { timeZone: 'Africa/Porto-Novo' });
    X.telecharger(blob, `Audit_Igeo_${jour}.xlsx`);
    return { feuilles: wb.SheetNames.length, sessions: sessions.length };
  }

  window.AuditExport = { exporter };
})();
