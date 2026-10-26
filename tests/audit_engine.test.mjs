// Tests de l'onglet « Audit » : node --test tests/
// Formes des données reprises de l'API Igeo réelle (unf, ujb, rep, lignes du tableau Logins).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../public/js/groupe_client.js');
const E = require('../public/js/audit_engine.js');

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0) / 1000; // 26/10/2026 13:00 au Bénin
const J = 86400;

test('classerSite : applications du journal Wialon', () => {
  const cas = {
    'web/track.igeo.africa': ['Web', 'Web track.igeo.africa'],
    'web/track.igeo.africa.': ['Web', 'Web track.igeo.africa'],
    'web/track.cobi.africa': ['Web', 'Web track.cobi.africa'],
    'web/41.86.241.11': ['Web', 'Web (adresse IP)'],
    'web/cms.igeo.africa': ['CMS', 'CMS cms.igeo.africa'],
    'cms.cobi.africa': ['CMS', 'CMS cms.cobi.africa'],
    'mwca.igeo.bourjon.track.os36.v6280': ['Android', 'App Igeo (Android)'],
    'mwca.com.gurtam.wialon_local_1504.os29.v6533': ['Android', 'App Wialon Local (Android)'],
    'mwca.com.gurtam.wiatag': ['Android', 'WiaTag (Android)'],
    'mwci.com.gurtam.wialonLocal.os26.v22226': ['iOS', 'App Wialon Local (iOS)'],
    'gapp_fleetrun': ['Apps Wialon', 'Fleetrun'],
    'track.igeo.africa locator': ['Locator', 'Locator (lien de suivi)'],
    'track.igeo.africa': ['API / jeton', 'API / jeton (track.igeo.africa)']
  };
  for (const [site, [famille, libelle]] of Object.entries(cas)) {
    assert.deepEqual(E.classerSite(site), { famille, libelle }, site);
  }
});

test('periodiciteTache : quotidien, mensuel (sch.m), hebdomadaire, intervalle', () => {
  assert.deepEqual(E.periodiciteTache({ r: '1 08:00', sch: { m: 0, w: 0, y: 0 } }), { libelle: 'Chaque jour à 08:00', secondes: J });
  assert.deepEqual(E.periodiciteTache({ r: '1 8', sch: {} }), { libelle: 'Chaque jour à 08:00', secondes: J });
  assert.deepEqual(E.periodiciteTache({ r: '1 07:00', sch: { m: 1 } }), { libelle: 'Le 1er du mois à 07:00', secondes: 31 * J });
  assert.deepEqual(E.periodiciteTache({ r: '1 09:30', sch: { w: 1 | 16 } }), { libelle: 'Chaque lun, ven à 09:30', secondes: 7 * J });
  assert.deepEqual(E.periodiciteTache({ r: '2 604800', sch: {} }), { libelle: 'Chaque semaine', secondes: 7 * J });
  assert.deepEqual(E.periodiciteTache({ r: '2 3600', sch: {} }), { libelle: 'Toutes les heures', secondes: 3600 });
});

test('statutConnexion : seuils 7 / 30 / 90 jours', () => {
  assert.equal(E.statutConnexion(0, NOW), 'Jamais connecté');
  assert.equal(E.statutConnexion(NOW - 2 * J, NOW), 'Actif (7 j)');
  assert.equal(E.statutConnexion(NOW - 20 * J, NOW), 'Actif (30 j)');
  assert.equal(E.statutConnexion(NOW - 60 * J, NOW), 'Dormant (30–90 j)');
  assert.equal(E.statutConnexion(NOW - 200 * J, NOW), 'Inactif (> 90 j)');
});

test('decomposer : heure du Bénin (UTC+1), lundi = 0', () => {
  const d = E.decomposer(Date.UTC(2026, 9, 25, 23, 30) / 1000); // dimanche 23:30 UTC = lundi 00:30 au Bénin
  assert.deepEqual(d, { jour: '2026-10-26', mois: '2026-10', semaine: 0, heure: 0 });
});

// Monde réduit : compte racine 199, revendeur TRACKING BOA (270), client dédié ABAS (2328).
function monde() {
  const res = (id, nom, compteId, extra = {}) => ({ id, nom, compteId, compteParentId: 199, createurId: 0, ...extra });
  const session = (u, t1, duree, site = 'web/track.igeo.africa', ip = '41.86.241.9') => [u, t1, t1 + duree, ip, site];
  return {
    genereLe: NOW,
    compteRacineId: 199,
    ressources: [
      res(199, '3DTechAfrica', 199, { compteParentId: 0, createurId: 198 }),
      res(270, 'TRACKING BOA', 270, { createurId: 269 }),
      res(322, 'AHA Transport', 270),
      res(323, 'ZED', 270),
      res(2328, 'ABAS CONSTRUCTION', 2328, { createurId: 2327 }),
      res(488, 'Rapport standards', 199)
    ],
    unites: [
      { id: 1, nom: 'CG 7812 RB', compteId: 270, active: true, clientField: '[AHA TRANSPORT]' },
      { id: 2, nom: 'CG 8150 RB', compteId: 270, active: true, clientField: '' },
      { id: 3, nom: 'ZD 0001', compteId: 270, active: false, clientField: '' },
      { id: 4, nom: 'ABAS 01', compteId: 2328, active: true, clientField: '' }
    ],
    groupes: [
      { id: 10, name: '[AHA TRANSPORT]', unitIds: [1, 2], multiClient: null, clientSpa: '' },
      { id: 12, name: '[ZED]', unitIds: [3], multiClient: null, clientSpa: '' },
      { id: 11, name: '(BOA)', unitIds: [1, 2, 3], multiClient: null, clientSpa: '' }
    ],
    utilisateurs: [
      { id: 269, nom: 'TRACKING BOA', compteId: 270, role: '' },
      { id: 300, nom: 'ahalogistique@gmail.com', compteId: 270, role: '' },
      { id: 301, nom: 'zed@gmail.com', compteId: 270, role: '' },
      { id: 302, nom: 'agandonou@bourjon.com', compteId: 199, role: '' },
      { id: 2327, nom: 'ABAS CONSTRUCTION', compteId: 2328, role: 'Support' },
      { id: 305, nom: 'support3dbogaz', compteId: 199, role: 'Support' },
      { id: 306, nom: 'tout@gmail.com', compteId: 270, role: '' }
    ],
    acces: { 1: [269, 300, 306], 2: [300, 306], 3: [301, 306], 4: [2327, 306] },
    alertes: [
      { id: 1, ressourceId: 322, n: 'Sortie de zone', fl: 0, ac: 12, ct: NOW - 100 * J, un: [10], expression: 'geozone_outside', trg: { t: 'geozone', p: {} }, act: [{ t: 'email', p: { email_to: 'aha@x.com' } }, { t: 'event', p: {} }] },
      { id: 2, ressourceId: 322, n: 'Vitesse', fl: 0, ac: 0, ct: NOW - 100 * J, un: [], trg: { t: 'speed', p: {} }, act: [{ t: 'sms', p: { phones: '' } }] },
      { id: 3, ressourceId: 323, n: 'Coupure', fl: 2, ac: 0, ct: NOW - 10 * J, un: [3], trg: { t: 'outage', p: {} }, act: [{ t: 'email', p: { email_to: 'z@x.com' } }] },
      { id: 4, ressourceId: 322, n: 'Sortie de zone (copie)', fl: 0, ac: 3, ct: NOW - 50 * J, un: [10], expression: 'geozone_outside', trg: { t: 'geozone', p: {} }, act: [{ t: 'email', p: { email_to: 'aha2@x.com' } }, { t: 'event', p: {} }] },
      { id: 5, ressourceId: 2328, n: 'Résumé (sans détail)', fl: 1, ac: 4, ct: NOW - 5 * J, un: [4], trg: 'speed', act: ['email', 'message'] }
    ],
    taches: [
      { id: 1, ressourceId: 322, n: 'Journalier AHA', r: '1 08:00', sch: {}, at: NOW - 200 * J, st: { e: 1, c: 120, l: NOW - 5 * J }, act: { t: 'send_email_report', p: { email_to: 'aha@x.com', report_guid: '488', report_id: '6', report_objects: '10', file_type: '10', time_from: '0', time_to: '1' } } },
      { id: 2, ressourceId: 322, n: 'Mensuel AHA', r: '1 07:00', sch: { m: 1 }, at: NOW - 200 * J, st: { e: 1, c: 6, l: NOW - 25 * J }, act: { t: 'send_email_report', p: { email_to: 'aha@x.com', report_guid: '488', report_id: '6', report_objects: '1', file_type: '2' } } },
      { id: 3, ressourceId: 323, n: 'Modèle perdu', r: '1 08:00', sch: {}, at: NOW - 30 * J, st: { e: 1, c: 30, l: NOW - 10 * J }, act: { t: 'send_email_report', p: { email_to: '', report_guid: '323', report_id: '9', report_objects: '3', time_from: '1759273200', time_to: '1760569199' } } },
      { id: 5, ressourceId: 323, n: 'Modèle non lisible', r: '1 08:00', sch: {}, at: NOW - 30 * J, st: { e: 1, c: 30, l: NOW - 3600 }, act: { t: 'send_email_report', p: { email_to: 'z@x.com', report_guid: '323', report_id: '9', report_objects: '3' } } },
      { id: 4, ressourceId: 2328, n: 'Désactivé', r: '2 604800', sch: {}, at: NOW - 30 * J, st: { e: 0, c: 0, l: 0 }, act: { t: 'send_email_report', p: { email_to: 'a@b.c', report_guid: '488', report_id: '6', report_objects: '4' } } }
    ],
    modeles: [{ id: 6, ressourceId: 488, n: 'Rapport journalier', ct: 'avl_unit_group', tbl: [{ n: 'unit_group_stats', l: 'Statistiques' }, { n: 'unit_group_trips', l: 'Trajets' }], bsfl: { ct: NOW - 400 * J, mt: NOW - 300 * J } }],
    connexions: {
      utilisateurs: [
        { nom: 'ahalogistique@gmail.com', premiere: 0, derniere: 0, nbSessions: 3 },
        { nom: 'zed@gmail.com', premiere: 0, derniere: 0, nbSessions: 1 },
        { nom: 'agandonou@bourjon.com', premiere: 0, derniere: 0, nbSessions: 1 },
        { nom: 'ancien@gmail.com', premiere: 0, derniere: 0, nbSessions: 1 }
      ],
      sessions: [
        session(0, NOW - 2 * J, 600, 'mwca.igeo.bourjon.track.os36.v6280', '102.202.111.1'),
        session(0, NOW - 40 * J, 1200),
        session(0, NOW - 3 * J, 5 * J), // session mobile restée ouverte : plafonnée à 24 h
        session(1, NOW - 120 * J, 300),
        session(2, NOW - J, 900),
        session(3, NOW - 400 * J, 60)
      ]
    }
  };
}

test('analyser : types, clients et statuts des utilisateurs', () => {
  const a = E.analyser(monde(), { maintenant: NOW });
  const u = Object.fromEntries(a.utilisateurs.map(x => [x.nom, x]));

  assert.equal(u['TRACKING BOA'].type, 'Revendeur');
  assert.equal(u['TRACKING BOA'].client, 'TRACKING BOA');
  assert.equal(u['agandonou@bourjon.com'].type, 'Interne');
  assert.equal(u['support3dbogaz'].type, 'Interne', 'rôle Support dans le compte racine');
  assert.equal(u['ABAS CONSTRUCTION'].type, 'Client', 'rôle Support sur un compte client dédié');

  // Client = majorité des véhicules (groupe « (BOA) » écarté car multi-clients), sinon compte dédié.
  assert.equal(u['ahalogistique@gmail.com'].client, '[AHA TRANSPORT]');
  assert.equal(u['zed@gmail.com'].client, '[ZED]');
  assert.equal(u['ABAS CONSTRUCTION'].client, 'ABAS CONSTRUCTION');
  assert.equal(u['tout@gmail.com'].client, 'Multi-clients (3)');

  assert.equal(u['ahalogistique@gmail.com'].statut, 'Actif (7 j)');
  assert.equal(u['zed@gmail.com'].statut, 'Inactif (> 90 j)');
  assert.equal(u['tout@gmail.com'].statut, 'Jamais connecté');
  assert.equal(u['ancien@gmail.com'].supprime, true);

  const aha = u['ahalogistique@gmail.com'];
  assert.equal(aha.sessions, 3);
  assert.equal(aha.duree, 600 + 1200 + J, 'session de 5 jours comptée 24 h');
  assert.equal(aha.appPrincipale, 'Web track.igeo.africa');
  assert.deepEqual(aha.familles, { Android: 1, Web: 2 });
});

test('analyser : la période ne change pas la dernière connexion ni le statut', () => {
  const a = E.analyser(monde(), { maintenant: NOW, depuis: NOW - 30 * J });
  const aha = a.utilisateurs.find(x => x.nom === 'ahalogistique@gmail.com');
  assert.equal(aha.sessions, 2);
  assert.equal(aha.sessionsTotal, 3);
  assert.equal(aha.statut, 'Actif (7 j)');
  // Graphiques : sessions de clients seulement (l'interne agandonou est exclu).
  assert.equal(a.synthese.parMois.reduce((s, m) => s + m.sessions, 0), 2);
  assert.equal(a.synthese.heatmap.flat().reduce((s, n) => s + n, 0), 2);
});

test('analyser : alertes (groupes surveillés, destinataires, doublons, résumé sans détail)', () => {
  const a = E.analyser(monde(), { maintenant: NOW });
  const al = Object.fromEntries(a.alertes.map(x => [x.id, x]));
  const textes = (x) => x.anomalies.map(y => y.texte);

  assert.equal(al[1].unites, 2, 'le groupe [AHA TRANSPORT] est développé');
  assert.equal(al[1].client, '[AHA TRANSPORT]');
  assert.equal(al[1].declencheur, 'Sortie de zone');
  assert.deepEqual(al[1].emails, ['aha@x.com']);
  assert.ok(textes(al[1]).some(t => t.startsWith('Doublon possible')));

  assert.ok(textes(al[2]).includes('Aucun véhicule surveillé'));
  assert.ok(textes(al[2]).includes('Action SMS sans numéro'));
  assert.ok(textes(al[2]).includes('Jamais déclenchée'));

  assert.equal(al[3].actif, false);
  assert.deepEqual(textes(al[3]), ['Alerte désactivée']);

  assert.equal(al[5].emails, null, 'résumé de la recherche : destinataires inconnus');
  assert.equal(al[5].chaqueMessage, true);
  assert.ok(!textes(al[5]).some(t => /destinataire/.test(t)));
});

test('analyser : rapports planifiés (retard, mensuel, modèle introuvable, période figée)', () => {
  const a = E.analyser(monde(), { maintenant: NOW });
  const t = Object.fromEntries(a.taches.map(x => [x.id, x]));
  const textes = (x) => x.anomalies.map(y => y.texte);

  assert.ok(textes(t[1]).some(x => x.startsWith('En retard')), 'quotidien sans envoi depuis 5 jours');
  assert.equal(t[1].modele, 'Rapport journalier');
  assert.equal(t[1].formats, 'PDF + XLSX');
  assert.equal(t[1].client, '[AHA TRANSPORT]');

  assert.deepEqual(textes(t[2]), [], 'mensuel envoyé il y a 25 jours : à l\'heure');
  assert.equal(t[2].periodicite, 'Le 1er du mois à 07:00');

  assert.ok(textes(t[3]).includes('Modèle de rapport introuvable'));
  assert.ok(textes(t[3]).includes('Aucun destinataire'));
  assert.ok(textes(t[3]).some(x => x.startsWith('Période figée')));
  assert.ok(textes(t[3]).includes('Tous les véhicules du rapport sont désactivés'));

  assert.deepEqual(textes(t[4]), ['Rapport planifié désactivé']);

  // Envoyé il y a une heure : le modèle existe mais n'est pas lisible avec le compte de la session.
  assert.ok(!textes(t[5]).includes('Modèle de rapport introuvable'));
  assert.equal(t[5].modele, 'Modèle #9 · ZED (non lisible avec ce compte)');

  const m = a.modeles[0];
  assert.deepEqual(m.tables, ['Trajets']);
  assert.equal(m.taches, 3);
  assert.equal(m.tachesActives, 2);
  assert.equal(m.envois, 126);
});

test('analyser : clients, anomalies et synthèse', () => {
  const a = E.analyser(monde(), { maintenant: NOW });
  const c = Object.fromEntries(a.clients.map(x => [x.nom, x]));
  assert.equal(c['[AHA TRANSPORT]'].vehicules, 2);
  assert.equal(c['[AHA TRANSPORT]'].alertesActives, 2);
  assert.equal(c['[AHA TRANSPORT]'].rapportsActifs, 2);
  assert.equal(c['[ZED]'].rapportsActifs, 2);
  assert.ok(c['[ZED]'].anomalies.some(x => /Aucune connexion depuis/.test(x.texte)) === false, 'aucun véhicule actif : pas d\'alerte client');
  assert.ok(c['ABAS CONSTRUCTION'].anomalies.some(x => x.texte === 'Aucun rapport planifié actif'));

  assert.ok(a.anomalies.some(x => x.categorie === 'Utilisateur' && x.objet === 'tout@gmail.com' && /Accès à 4 véhicules/.test(x.texte)));
  const prios = a.anomalies.map(x => x.priorite);
  assert.deepEqual(prios, prios.slice().sort((x, y) => x - y), 'anomalies triées par priorité');

  const s = a.synthese;
  assert.equal(s.vehicules, 4);
  assert.equal(s.vehiculesActifs, 3);
  assert.equal(s.utilisateurs, 7, 'sans l\'utilisateur supprimé');
  assert.equal(s.parType.Interne, 2);
  assert.equal(s.alertes.actives, 4);
  assert.equal(s.taches.actives, 4);
  assert.equal(s.taches.enRetard, 2);
});

test('sessionsDetaillees : période, sans API / jeton, plus récentes d\'abord', () => {
  const b = monde();
  b.connexions.sessions.push([2, NOW - 3600, NOW - 3000, '18.195.223.42', 'track.igeo.africa']);
  const a = E.analyser(b, { maintenant: NOW });
  const rows = E.sessionsDetaillees(b, a, NOW - 30 * J);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.famille !== 'API / jeton'));
  assert.ok(rows[0].debut >= rows[1].debut);
  assert.equal(rows.find(r => r.nom === 'ahalogistique@gmail.com').client, '[AHA TRANSPORT]');
});
