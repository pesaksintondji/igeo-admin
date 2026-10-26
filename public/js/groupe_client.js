/**
 * Groupe / Client d'un véhicule pour les colonnes « Groupe » des rapports (PR01, V02…).
 *
 * Un véhicule est souvent à la fois dans un groupe général (« 3DTechAfrica ») et dans son
 * groupe client (« [INOVA EXPRESS] ») : les groupes multi-clients sont écartés avant de choisir
 * le nom affiché.
 *  - Champ admin `groupe_multi_client` du groupe (admin.igeopilot.com) : oui = écarté,
 *    non = toujours groupe client, vide = détection automatique.
 *  - Détection automatique : le groupe contient entièrement au moins 2 autres groupes et son nom
 *    n'est pas au format « [CLIENT] » (convention des groupes clients du CRM).
 *  - Plusieurs groupes restants : on garde ceux choisis pour un compte client dans la SPA (champ
 *    admin `client_spa` du groupe, recopié par le cron de la SPA), puis celui qui porte le nom du
 *    champ admin `client` du véhicule. S'il en reste plusieurs : tous les noms, triés, « · ».
 *  - Aucun groupe restant : champ admin `client` du véhicule, sinon chaîne vide.
 *
 * Jumelle de detectMultiClientGroups : igeo-admin/public/js/admin_engine.js (garder la même règle).
 */
(function (root) {
  const CLIENT_NAME = /^\s*\[.*\]\s*$/;
  // Nom comparable : sans accents, crochets, parenthèses ni casse.
  const comparable = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  // Map(groupId → [noms des groupes entièrement contenus]) pour les groupes détectés multi-clients.
  function detectMultiClientGroups(groups) {
    const list = (groups || []).map(g => ({ id: Number(g.id), name: g.name || '', units: new Set((g.unitIds || []).map(Number)) }));
    const res = new Map();
    for (const g of list) {
      if (g.units.size < 2 || CLIENT_NAME.test(g.name)) continue;
      const contained = [];
      for (const h of list) {
        if (h.id === g.id || !h.units.size || h.units.size >= g.units.size) continue;
        let inside = true;
        for (const u of h.units) { if (!g.units.has(u)) { inside = false; break; } }
        if (inside) contained.push(h.name);
      }
      if (contained.length >= 2) res.set(g.id, contained);
    }
    return res;
  }

  // Ensemble des ids de groupes écartés : champ admin à oui, ou champ vide et détection automatique.
  function excludedGroupIds(groups) {
    const auto = detectMultiClientGroups(groups);
    const ids = new Set();
    for (const g of groups || []) {
      const id = Number(g.id);
      if (g.multiClient === true || (g.multiClient !== false && auto.has(id))) ids.add(id);
    }
    return ids;
  }

  function clientLabel(unit, groups, excluded) {
    if (!unit) return '';
    const skip = excluded || excludedGroupIds(groups);
    const uid = Number(unit.id);
    const champ = String(unit.clientField || '').trim();
    let cands = (groups || []).filter(g => g.name && !skip.has(Number(g.id)) && (g.unitIds || []).some(id => Number(id) === uid));
    if (cands.length > 1) {
      const spa = cands.filter(g => String(g.clientSpa || '').trim());
      if (spa.length) cands = spa;
    }
    if (cands.length > 1 && champ) {
      const parChamp = cands.filter(g => comparable(g.name) === comparable(champ));
      if (parChamp.length === 1) cands = parChamp;
    }
    const names = [...new Set(cands.map(g => g.name))].sort((a, b) => a.localeCompare(b, 'fr'));
    return names.length ? names.join(' · ') : champ;
  }

  root.GroupeClient = { detectMultiClientGroups, excludedGroupIds, clientLabel };
})(typeof window !== 'undefined' ? window : globalThis);
