/**
 * Vérification de l'onglet « Audit » contre l'API Igeo réelle, en lecture seule : mêmes fonctions de
 * collecte et d'analyse que le navigateur (public/js/audit_engine.js), sans AdminEngine.loadAllData
 * (qui synchronise des champs en arrière-plan).
 *
 *   node scripts/audit_smoke.mjs                     # résumé des chiffres
 *   node scripts/audit_smoke.mjs --journal 5         # + journal des modifications sur 5 ressources
 *   node scripts/audit_smoke.mjs --json audit.json   # + données brutes et analyse dans un fichier
 *
 * Jeton : IGEO_TOKEN, sinon la ligne IGEO_TOKEN= du .env de la SPA (~/Desktop/Single Page Application/.env).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../public/js/groupe_client.js');
require('../public/js/admin_engine.js');
const E = require('../public/js/audit_engine.js');
const engine = globalThis.AdminEngine;

const API = 'https://track.igeo.africa/wialon/ajax.html';
const arg = (nom) => { const i = process.argv.indexOf(nom); return i > 0 ? process.argv[i + 1] : null; };

function lireJeton() {
  if (process.env.IGEO_TOKEN) return process.env.IGEO_TOKEN;
  const env = join(homedir(), 'Desktop', 'Single Page Application', '.env');
  if (existsSync(env)) {
    const ligne = readFileSync(env, 'utf8').split('\n').find(l => l.startsWith('IGEO_TOKEN='));
    if (ligne) return ligne.slice('IGEO_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('IGEO_TOKEN introuvable (variable d\'environnement ou .env de la SPA)');
}

let sid = null;
async function brut(svc, params) {
  const body = new URLSearchParams({ svc, params: JSON.stringify(params || {}) });
  if (sid) body.set('sid', sid);
  const res = await fetch(API, { method: 'POST', body });
  return res.json();
}
const api = {
  async call(svc, params) {
    const d = await brut(svc, params);
    if (d && typeof d === 'object' && !Array.isArray(d) && d.error) {
      const e = new Error(`Igeo ${svc} : erreur ${d.error}`);
      e.code = d.error;
      throw e;
    }
    return d;
  },
  async batch(calls) {
    return calls.length ? api.call('core/batch', { params: calls, flags: 0 }) : [];
  },
  async batchChunked(calls) {
    const out = [];
    let paquet = [];
    let taille = 0;
    for (const c of calls) {
      const len = encodeURIComponent(JSON.stringify(c)).length;
      if (paquet.length && taille + len > 400000) { out.push(...await api.batch(paquet)); paquet = []; taille = 0; }
      paquet.push(c);
      taille += len;
    }
    if (paquet.length) out.push(...await api.batch(paquet));
    return out;
  }
};

const recherche = (itemsType, flags) => ({ svc: 'core/search_items', params: { spec: { itemsType, propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' }, force: 1, flags, from: 0, to: 0 } });
const entite = (it) => ({ id: Number(it.id), name: it.nm, raw: { id: it.id, nm: it.nm, aflds: it.aflds || {}, flds: it.flds || {} } });

const t0 = Date.now();
const login = await brut('token/login', { token: lireJeton(), fl: 2 });
if (!login.eid) throw new Error(`Connexion Igeo refusée : ${JSON.stringify(login)}`);
sid = login.eid;
const compteRacineId = Number(login.user && login.user.bact);
console.log(`Session ${login.au} · compte ${compteRacineId}`);

const [unitsRes, groupsRes, usersRes] = await api.batch([recherche('avl_unit', 0x1 | 0x8 | 0x80), recherche('avl_unit_group', 0x1 | 0x8 | 0x80), recherche('user', 0x1 | 0x4 | 0x8 | 0x80)]);
const state = {
  schema: engine.DEFAULT_SCHEMA,
  units: unitsRes.items.map(entite),
  groups: groupsRes.items.map(g => ({ ...entite(g), unitIds: (g.u || []).map(Number) })),
  users: usersRes.items.map(u => ({ ...entite(u), accountId: Number(u.bact || 0) }))
};

const progres = (msg) => process.stdout.write(`\r${msg.padEnd(90).slice(0, 90)}`);
const configuration = await E.collecterConfiguration(api, { onProgress: progres });
const acces = await E.collecterAcces(api, state.units.map(u => u.id));
const connexions = await E.collecterConnexions(api, compteRacineId, { onProgress: progres });
process.stdout.write('\n');

const brutAudit = E.preparerBrut({ engine, state, configuration, acces, connexions, compteRacineId });
const t1 = Date.now();
const analyse = E.analyser(brutAudit);
const a30 = E.analyser(brutAudit, { depuis: brutAudit.genereLe - 30 * E.JOUR });
const s = analyse.synthese;
console.log(`Collecte ${((t1 - t0) / 1000).toFixed(1)} s · analyse ${Date.now() - t1} ms`);
console.log(`Ressources ${s.ressources} (comptes ${s.comptes}) · véhicules ${s.vehicules} (${s.vehiculesActifs} actifs) · utilisateurs ${s.utilisateurs}`, s.parType);
console.log(`Modèles ${s.modeles} · rapports planifiés ${s.taches.total} (${s.taches.actives} actifs, ${s.taches.enRetard} en retard, ${s.taches.envois} envois) · alertes ${s.alertes.total} (${s.alertes.actives} actives)`);
console.log(`Journal : ${connexions.utilisateurs.length} utilisateurs, ${connexions.sessions.length} sessions (somme des lignes : ${connexions.utilisateurs.reduce((x, u) => x + u.nbSessions, 0)})`);
console.log(`Sessions clients : tout ${s.sessionsClients} · 30 j ${a30.synthese.sessionsClients} (${a30.synthese.utilisateursPeriode} utilisateurs) · statuts`, s.parStatut);
console.log('Familles (tout) :', s.familles.map(f => `${f.famille} ${f.sessions}/${f.utilisateurs}`).join(' · '));
console.log('Anomalies :', s.anomalies, '· clients :', s.clients);
console.log('Top clients :', analyse.clients.slice(0, 8).map(c => `${c.nom} (${c.sessions} s., ${c.utilisateurs} u., ${c.vehicules} v.)`).join(' · '));
for (const nom of ['ahalogistique@gmail.com', 'efficientdeliverybymeraya@gmail.com', '3DTechAfrica']) {
  const u = analyse.utilisateurs.find(x => x.nom === nom);
  if (u) console.log(`  ${nom} : ${u.type} · ${u.client} · ${u.sessionsTotal} sessions · dernière ${new Date(u.derniere * 1000).toISOString()} · ${u.appPrincipale} · ${u.vehicules} véhicules · ${u.statut}`);
}

const nbJournal = Number(arg('--journal')) || 0;
let journal = null;
if (nbJournal) {
  journal = await E.collecterJournal(api, configuration.ressources.slice(0, nbJournal), { jours: 90, onProgress: progres });
  process.stdout.write('\n');
  console.log(`Journal des modifications : ${journal.lignes.length} lignes, SMS ${journal.sms.length} lignes`, journal.lignes.slice(0, 3), journal.sms.slice(0, 2));
}

const sortie = arg('--json');
if (sortie) {
  writeFileSync(sortie, JSON.stringify({ brut: brutAudit, analyse, journal }));
  console.log(`Écrit : ${sortie}`);
}
await brut('core/logout', {});
