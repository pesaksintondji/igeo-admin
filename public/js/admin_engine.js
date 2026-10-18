/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOTEUR D'ADMINISTRATION IGEO — PERMISSIONS, CHAMPS TYPÉS & RÈGLES MATÉRIELLES
 * ═══════════════════════════════════════════════════════════════════════════════
 * - Charge les Véhicules (avl_unit), Groupes (avl_unit_group), Utilisateurs (user),
 *   Ressources (avl_resource) et Modèles de boîtiers (core/get_hw_types).
 * - Gère la lecture/écriture des champs administratifs (aflds) et personnalisés (flds)
 *   avec héritage Groupe -> Véhicule.
 * - Persiste le schéma dynamique de permissions & champs typés dans Wialon
 *   (_igeo_admin_schema_v1 sur la ressource principale) + cache local.
 * - Exécute la règle métier de Remplacement d'IMEI (Swap de boîtier) avec libération
 *   automatique d'un éventuel doublon stock et archivage de l'historique dans aflds.
 */
(function () {
  const api = () => window.IgeoApi;

  const UNIT_FLAGS = 0x1 | 0x8 | 0x80 | 0x100 | 0x1000 | 0x2000 | 0x800000;
  const GROUP_FLAGS = 0x1 | 0x8 | 0x80;
  const USER_FLAGS = 0x1 | 0x8 | 0x80;
  const RES_FLAGS = 0x1 | 0x8 | 0x80;

  const SCHEMA_FIELD_NAME = '_igeo_admin_schema_v1';
  const SWAP_HISTORY_FIELD = '_igeo_swap_history';
  const LOCAL_SCHEMA_KEY = 'igeo_admin_schema_cache_v1';

  const DEFAULT_SCHEMA = [
    {
      key: 'ecodrive',
      label: 'Éco-conduite (EC04)',
      description: 'Active le véhicule ou le groupe dans le rapport Éco-conduite EC04',
      type: 'boolean',
      targets: ['unit', 'group'],
      required: false,
      icon: 'eco',
      color: '#16a34a',
      storage: 'aflds',
      category: 'permission',
      system: true
    },
    {
      key: 'carburant',
      label: 'Carburant (V20)',
      description: 'Active le véhicule ou le groupe dans le rapport Gestion Carburant V20',
      type: 'boolean',
      targets: ['unit', 'group'],
      required: false,
      icon: 'local_gas_station',
      color: '#2563eb',
      storage: 'aflds',
      category: 'permission',
      system: true
    },
    {
      key: 'coupure_moteur',
      label: 'Coupure moteur autorisée',
      description: 'Autorise l’utilisateur ou le véhicule à exécuter une coupure moteur à distance',
      type: 'boolean',
      targets: ['user', 'unit', 'group'],
      required: false,
      icon: 'power_settings_new',
      color: '#dc2626',
      storage: 'aflds',
      category: 'permission',
      system: false
    },
    {
      key: 'rapport_journalier',
      label: 'Reçoit Rapport Journalier',
      description: 'Active l’envoi ou la génération du rapport journalier V13 pour cet utilisateur / groupe',
      type: 'boolean',
      targets: ['user', 'group', 'unit'],
      required: false,
      icon: 'forward_to_inbox',
      color: '#7c3aed',
      storage: 'aflds',
      category: 'permission',
      system: false
    },
    {
      key: 'date_installation',
      label: 'Date d’installation',
      description: 'Date de pose initiale de la balise GPS (format AAAA-MM-JJ uniquement)',
      type: 'date',
      targets: ['unit'],
      required: true,
      icon: 'event_available',
      color: '#0284c7',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'statut_exploitation',
      label: 'Statut d’exploitation',
      description: 'État opérationnel du véhicule dans la flotte',
      type: 'select',
      options: ['Actif', 'En maintenance', 'Suspendu', 'Hors service'],
      targets: ['unit'],
      required: false,
      icon: 'verified',
      color: '#0d9488',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'ancien_imei',
      label: 'Ancien IMEI',
      description: 'Identifiant du précédent boîtier (archivé automatiquement lors d’un swap)',
      type: 'text',
      targets: ['unit'],
      required: false,
      icon: 'history',
      color: '#64748b',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'date_dernier_swap',
      label: 'Date dernier Swap',
      description: 'Date du dernier remplacement d’IMEI sur ce véhicule',
      type: 'date',
      targets: ['unit'],
      required: false,
      icon: 'swap_horiz',
      color: '#d97706',
      storage: 'aflds',
      category: 'field',
      system: false
    }
  ];

  function normalizeKey(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function normalizeMatch(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Recherche un champ par son nom dans aflds ou flds (insensible à la casse et aux accents)
   */
  function findFieldEntry(rawItem, fieldKey, storage = 'aflds') {
    if (!rawItem) return null;
    const target = normalizeMatch(fieldKey);
    const aliases = [target];
    if (target === 'carburant') aliases.push('fuel');
    if (target === 'ecodrive') aliases.push('eco_drive', 'eco-drive', 'ecoconduite');

    const dicts = storage === 'flds'
      ? [rawItem.flds, rawItem.aflds]
      : [rawItem.aflds, rawItem.flds];

    for (const dict of dicts) {
      if (!dict) continue;
      for (const entry of Object.values(dict)) {
        if (!entry || !entry.n) continue;
        if (aliases.includes(normalizeMatch(entry.n))) {
          return {
            id: entry.id,
            name: entry.n,
            value: entry.v != null ? String(entry.v).trim() : '',
            dictName: dict === rawItem.flds ? 'flds' : 'aflds'
          };
        }
      }
    }
    return null;
  }

  function parseBoolValue(rawVal) {
    if (rawVal == null) return null;
    const v = normalizeMatch(rawVal);
    if (!v) return null;
    if (/^(oui|yes|1|true|vrai|actif|active|ok|exploitable)$/i.test(v)) return true;
    if (/^(non|no|0|false|faux|inactif|inactive)$/i.test(v)) return false;
    return null;
  }

  function getFieldRawValue(entity, fieldDef) {
    const entry = findFieldEntry(entity.raw, fieldDef.key, fieldDef.storage);
    if (!entry) return '';
    return entry.value;
  }

  /**
   * Pour un champ booléen (permission) :
   * - Sur un groupe ou utilisateur : renvoie { own: true|false|null, effective: boolean, inheritedFrom: null }
   * - Sur un véhicule : calcule l'héritage depuis ses groupes si own === null
   */
  function evaluatePermission(entity, fieldDef, groupsById) {
    const rawVal = getFieldRawValue(entity, fieldDef);
    const own = parseBoolValue(rawVal);

    if (entity.entityType === 'unit' && Array.isArray(entity.groupIds) && groupsById) {
      let inheritedGroup = null;
      for (const gId of entity.groupIds) {
        const g = groupsById.get(gId);
        if (g) {
          const gVal = parseBoolValue(getFieldRawValue(g, fieldDef));
          if (gVal === true) {
            inheritedGroup = g;
            break;
          }
        }
      }
      const effective = own !== null ? own : !!inheritedGroup;
      return {
        own, // true ('oui'), false ('non'), ou null (hérité / non défini)
        effective,
        inheritedFrom: own === null && inheritedGroup ? inheritedGroup.name : null,
        overridden: own !== null && inheritedGroup != null && own !== true
      };
    }

    return {
      own,
      effective: own === true,
      inheritedFrom: null,
      overridden: false
    };
  }

  /**
   * Validation stricte d'une valeur selon le type du champ
   */
  function validateFieldValue(fieldDef, value) {
    const str = String(value == null ? '' : value).trim();
    if (!str) {
      if (fieldDef.required) {
        return { valid: false, reason: `Le champ « ${fieldDef.label} » est obligatoire.` };
      }
      return { valid: true, normalized: '' };
    }

    if (fieldDef.type === 'boolean') {
      const b = parseBoolValue(str);
      if (b === null) {
        return { valid: false, reason: `Valeur attendue pour « ${fieldDef.label} » : oui ou non.` };
      }
      return { valid: true, normalized: b ? 'oui' : 'non' };
    }

    if (fieldDef.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return { valid: false, reason: `Le champ « ${fieldDef.label} » exige une date valide au format AAAA-MM-JJ.` };
      }
      const d = new Date(str + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) {
        return { valid: false, reason: `Date invalide pour « ${fieldDef.label} ».` };
      }
      return { valid: true, normalized: str };
    }

    if (fieldDef.type === 'number') {
      const num = Number(str.replace(',', '.'));
      if (!Number.isFinite(num)) {
        return { valid: false, reason: `Le champ « ${fieldDef.label} » n'accepte que des valeurs numériques.` };
      }
      return { valid: true, normalized: String(num) };
    }

    if (fieldDef.type === 'select') {
      const opts = Array.isArray(fieldDef.options) ? fieldDef.options : [];
      if (opts.length && !opts.includes(str)) {
        return { valid: false, reason: `Valeur « ${str} » non autorisée pour « ${fieldDef.label} ».` };
      }
      return { valid: true, normalized: str };
    }

    return { valid: true, normalized: str };
  }

  /**
   * Vérifie si une entité a tous ses champs obligatoires renseignés et valides
   */
  function getMissingRequiredFields(entity, schema) {
    const relevant = schema.filter(f => f.required && f.targets.includes(entity.entityType));
    const missing = [];
    for (const f of relevant) {
      const val = getFieldRawValue(entity, f);
      const check = validateFieldValue(f, val);
      if (!val || !check.valid) {
        missing.push(f);
      }
    }
    return missing;
  }

  function mergeSchemaWithDefaults(customList) {
    const map = new Map();
    for (const d of DEFAULT_SCHEMA) {
      map.set(d.key, { ...d });
    }
    if (Array.isArray(customList)) {
      for (const item of customList) {
        if (!item || !item.key) continue;
        const k = normalizeKey(item.key);
        if (!k) continue;
        const existing = map.get(k);
        map.set(k, {
          ...(existing || {}),
          ...item,
          key: k,
          system: existing ? existing.system : false
        });
      }
    }
    return [...map.values()];
  }

  function loadCachedSchema() {
    try {
      const raw = localStorage.getItem(LOCAL_SCHEMA_KEY);
      if (raw) return mergeSchemaWithDefaults(JSON.parse(raw));
    } catch (_e) {}
    return mergeSchemaWithDefaults([]);
  }

  function saveCachedSchema(schema) {
    try {
      localStorage.setItem(LOCAL_SCHEMA_KEY, JSON.stringify(schema));
    } catch (_e) {}
  }

  /**
   * Charge toutes les données nécessaires en un seul appel core/batch + get_hw_types
   */
  async function loadAllData() {
    const search = (itemsType, flags) => ({
      svc: 'core/search_items',
      params: {
        spec: { itemsType, propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
        force: 1,
        flags,
        from: 0,
        to: 0
      }
    });

    const [batchRes, hwTypesRes] = await Promise.all([
      api().batch([
        search('avl_unit', UNIT_FLAGS),
        search('avl_unit_group', GROUP_FLAGS),
        search('user', USER_FLAGS),
        search('avl_resource', RES_FLAGS)
      ]),
      api().call('core/get_hw_types', { filterType: 'name' }).catch(() => [])
    ]);

    const [unitsRes, groupsRes, usersRes, resRes] = batchRes || [];
    if (!unitsRes || unitsRes.error) {
      throw new api().IgeoError(unitsRes ? unitsRes.error : 5, 'core/search_items', 'Impossible de charger les véhicules');
    }

    const hwById = new Map();
    if (Array.isArray(hwTypesRes)) {
      for (const hw of hwTypesRes) {
        if (hw && hw.id) hwById.set(Number(hw.id), hw);
      }
    }

    // Ressource principale pour stocker le schéma partagé
    const resources = (resRes && resRes.items) || [];
    resources.sort((a, b) => {
      const aPri = /3dt|3dtech|igeo/i.test(a.nm || '') ? 1 : 0;
      const bPri = /3dt|3dtech|igeo/i.test(b.nm || '') ? 1 : 0;
      return bPri - aPri;
    });
    const primaryResource = resources[0] || null;

    // Lecture du schéma depuis la ressource principale (ou cache local par défaut)
    let schema = loadCachedSchema();
    if (primaryResource) {
      const schemaEntry = findFieldEntry(primaryResource, SCHEMA_FIELD_NAME, 'aflds');
      if (schemaEntry && schemaEntry.value) {
        try {
          schema = mergeSchemaWithDefaults(JSON.parse(schemaEntry.value));
          saveCachedSchema(schema);
        } catch (_e) {}
      }
    }

    // Groupes
    const groups = ((groupsRes && groupsRes.items) || []).map(g => ({
      id: g.id,
      entityType: 'group',
      name: g.nm || `Groupe #${g.id}`,
      unitIds: Array.isArray(g.u) ? g.u : [],
      raw: {
        id: g.id,
        nm: g.nm,
        aflds: g.aflds ? { ...g.aflds } : {},
        flds: g.flds ? { ...g.flds } : {}
      }
    }));

    const groupsById = new Map(groups.map(g => [g.id, g]));
    const groupIdsByUnitId = new Map();
    for (const g of groups) {
      for (const uId of g.unitIds) {
        if (!groupIdsByUnitId.has(uId)) groupIdsByUnitId.set(uId, []);
        groupIdsByUnitId.get(uId).push(g.id);
      }
    }

    // Véhicules
    const units = ((unitsRes && unitsRes.items) || []).map(it => {
      const gIds = groupIdsByUnitId.get(it.id) || [];
      const hwId = it.hw ? Number(it.hw) : 0;
      const hwObj = hwById.get(hwId);
      return {
        id: it.id,
        entityType: 'unit',
        name: it.nm || `Unité #${it.id}`,
        imei: it.uid ? String(it.uid) : '',
        imei2: it.uid2 ? String(it.uid2) : '',
        phone: it.ph ? String(it.ph) : '',
        hwId,
        hwName: hwObj ? hwObj.name : (hwId ? `Boîtier #${hwId}` : 'Non défini'),
        groupIds: gIds,
        groupNames: gIds.map(id => (groupsById.get(id) ? groupsById.get(id).name : '')).filter(Boolean),
        raw: {
          id: it.id,
          nm: it.nm,
          aflds: it.aflds ? { ...it.aflds } : {},
          flds: it.flds ? { ...it.flds } : {},
          pflds: it.pflds ? { ...it.pflds } : {}
        }
      };
    });

    // Utilisateurs
    const users = ((usersRes && usersRes.items) || []).map(u => ({
      id: u.id,
      entityType: 'user',
      name: u.nm || `Utilisateur #${u.id}`,
      raw: {
        id: u.id,
        nm: u.nm,
        aflds: u.aflds ? { ...u.aflds } : {},
        flds: u.flds ? { ...u.flds } : {}
      }
    }));

    return {
      units,
      groups,
      groupsById,
      users,
      resources,
      primaryResource,
      hwTypes: Array.isArray(hwTypesRes) ? hwTypesRes : [],
      hwById,
      schema
    };
  }

  /**
   * Construit l'appel Wialon pour créer, modifier ou supprimer un champ dans aflds / flds
   */
  function buildFieldUpdateCall(rawItem, fieldKey, newValue, storage = 'aflds') {
    const svc = storage === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
    const existing = findFieldEntry(rawItem, fieldKey, storage);
    const dictMatch = existing && existing.dictName === (storage === 'flds' ? 'flds' : 'aflds') ? existing : null;
    const strVal = newValue == null ? '' : String(newValue).trim();

    if (!strVal) {
      if (!dictMatch) return null; // Rien à supprimer
      return {
        svc,
        params: {
          itemId: rawItem.id,
          id: dictMatch.id,
          callMode: 'delete'
        },
        _meta: { rawItem, fieldKey, strVal: '', storage, mode: 'delete', oldId: dictMatch.id }
      };
    }

    if (dictMatch) {
      return {
        svc,
        params: {
          itemId: rawItem.id,
          id: dictMatch.id,
          callMode: 'update',
          n: dictMatch.name,
          v: strVal
        },
        _meta: { rawItem, fieldKey: dictMatch.name, strVal, storage, mode: 'update', oldId: dictMatch.id }
      };
    }

    return {
      svc,
      params: {
        itemId: rawItem.id,
        id: 0,
        callMode: 'create',
        n: fieldKey,
        v: strVal
      },
      _meta: { rawItem, fieldKey, strVal, storage, mode: 'create' }
    };
  }

  /**
   * Applique la réponse de item/update_admin_field sur l'objet en mémoire
   */
  function applyLocalFieldMutation(meta, resItem) {
    const dictKey = meta.storage === 'flds' ? 'flds' : 'aflds';
    if (!meta.rawItem[dictKey]) meta.rawItem[dictKey] = {};
    const dict = meta.rawItem[dictKey];

    if (meta.mode === 'delete') {
      for (const [k, v] of Object.entries(dict)) {
        if (v && (v.id === meta.oldId || normalizeMatch(v.n) === normalizeMatch(meta.fieldKey))) {
          delete dict[k];
        }
      }
      return;
    }

    // Wialon renvoie [id, { id, n, v }] sur create/update
    if (Array.isArray(resItem) && resItem[1] && typeof resItem[1] === 'object') {
      const fObj = resItem[1];
      dict[String(fObj.id)] = { id: fObj.id, n: fObj.n || meta.fieldKey, v: meta.strVal };
      return;
    }

    // Fallback optimiste si la réponse est vide mais sans erreur
    const fallbackId = meta.oldId || Date.now() % 100000;
    dict[String(fallbackId)] = { id: fallbackId, n: meta.fieldKey, v: meta.strVal };
  }

  /**
   * Met à jour un champ (ou une permission) sur une ou plusieurs entités en un seul lot core/batch
   */
  async function updateFieldOnEntities(entities, fieldDef, rawNewValue) {
    const strVal = rawNewValue == null ? '' : String(rawNewValue).trim();
    if (strVal !== '') {
      const check = validateFieldValue(fieldDef, strVal);
      if (!check.valid) {
        throw new Error(check.reason);
      }
    }

    const callsWithMeta = [];
    for (const ent of entities) {
      const callObj = buildFieldUpdateCall(ent.raw, fieldDef.key, strVal, fieldDef.storage || 'aflds');
      if (callObj) callsWithMeta.push(callObj);
    }

    if (!callsWithMeta.length) return { updated: 0 };

    const batchPayload = callsWithMeta.map(c => ({ svc: c.svc, params: c.params }));
    const results = await api().batchChunked(batchPayload);

    let errors = [];
    results.forEach((res, idx) => {
      const meta = callsWithMeta[idx]._meta;
      if (res && res.error) {
        errors.push(`Erreur Wialon (${res.error}) sur ${meta.rawItem.nm || meta.rawItem.id}`);
      } else {
        applyLocalFieldMutation(meta, res);
      }
    });

    if (errors.length) {
      throw new Error(errors.slice(0, 3).join(' · '));
    }

    return { updated: callsWithMeta.length };
  }

  /**
   * Sauvegarde le schéma personnalisé dans Wialon (sur la ressource principale) + cache local
   */
  async function saveSchema(schema, primaryResource) {
    const merged = mergeSchemaWithDefaults(schema);
    saveCachedSchema(merged);

    if (primaryResource) {
      const callObj = buildFieldUpdateCall(primaryResource, SCHEMA_FIELD_NAME, JSON.stringify(merged), 'aflds');
      if (callObj) {
        try {
          const [res] = await api().batch([{ svc: callObj.svc, params: callObj.params }]);
          if (!res || !res.error) {
            applyLocalFieldMutation(callObj._meta, res);
          }
        } catch (e) {
          console.warn('[AdminEngine] Sauvegarde distante du schéma ignorée (cache local actif) :', e);
        }
      }
    }
    return merged;
  }

  /**
   * Lecture de l'historique des remplacements d'IMEI d'un véhicule
   */
  function getUnitSwapHistory(unit) {
    const entry = findFieldEntry(unit.raw, SWAP_HISTORY_FIELD, 'aflds');
    if (entry && entry.value) {
      try {
        const list = JSON.parse(entry.value);
        if (Array.isArray(list)) return list;
      } catch (_e) {}
    }
    const oldImei = getFieldRawValue(unit, { key: 'ancien_imei', storage: 'aflds' });
    const lastDate = getFieldRawValue(unit, { key: 'date_dernier_swap', storage: 'aflds' });
    if (oldImei) {
      return [{
        date: lastDate || '—',
        oldImei,
        newImei: unit.imei || '—',
        reason: 'Remplacement boîtier'
      }];
    }
    return [];
  }

  /**
   * RÈGLE MÉTIER : Remplacement de l'IMEI d'un véhicule (Swap de boîtier)
   * 1. Vérifie que le nouvel IMEI est valide.
   * 2. Si le nouvel IMEI est déjà affecté à une autre fiche dans Wialon (ex: fiche Stock/Test)
   *    et que autoFreeConflict = true, libère d'abord l'IMEI sur cette fiche stock.
   * 3. Met à jour l'IMEI (et le type matériel hwId) sur le véhicule cible via unit/update_device_type.
   * 4. Archive automatiquement l'ancien IMEI, la date du swap et l'historique complet dans aflds.
   */
  async function replaceUnitImei({ unit, newImei, newHwId, swapDate, reason, autoFreeConflict = true, allUnits = [], userName = '' }) {
    const cleanNewImei = String(newImei || '').trim();
    if (!cleanNewImei || !/^[A-Za-z0-9_-]{4,32}$/.test(cleanNewImei)) {
      throw new Error('Veuillez saisir un identifiant IMEI / boîtier valide (4 à 32 caractères alphanumériques).');
    }

    const oldImei = unit.imei || '';
    if (cleanNewImei === oldImei && (!newHwId || Number(newHwId) === Number(unit.hwId))) {
      throw new Error('Le nouvel IMEI est identique à l’IMEI actuel de ce véhicule.');
    }

    const effectiveDate = swapDate && /^\d{4}-\d{2}-\d{2}$/.test(swapDate)
      ? swapDate
      : new Date().toISOString().slice(0, 10);

    const targetHwId = Number(newHwId || unit.hwId || 0);
    if (!targetHwId) {
      throw new Error('Type de boîtier (matériel Wialon) requis pour mettre à jour l’IMEI.');
    }

    // 1. Détection d'un éventuel doublon sur une autre unité
    const conflictUnit = allUnits.find(u => u.id !== unit.id && (u.imei === cleanNewImei || u.imei2 === cleanNewImei));
    let freedUnitName = null;

    if (conflictUnit) {
      if (!autoFreeConflict) {
        throw new Error(`Le nouvel IMEI (${cleanNewImei}) est déjà utilisé sur le véhicule « ${conflictUnit.name} ».`);
      }
      const archiveUid = `OLD_${cleanNewImei}_${Date.now().toString().slice(-4)}`;
      await api().call('unit/update_device_type', {
        itemId: conflictUnit.id,
        deviceTypeId: Number(conflictUnit.hwId || targetHwId),
        uniqueId: archiveUid
      });
      conflictUnit.imei = archiveUid;
      freedUnitName = conflictUnit.name;

      // Trace sur l'unité stock libérée
      const noteCall = buildFieldUpdateCall(
        conflictUnit.raw,
        'note_transfert_boitier',
        `Boîtier ${cleanNewImei} transféré vers ${unit.name} le ${effectiveDate}`,
        'aflds'
      );
      if (noteCall) {
        const [r] = await api().batch([{ svc: noteCall.svc, params: noteCall.params }]);
        if (!r || !r.error) applyLocalFieldMutation(noteCall._meta, r);
      }
    }

    // 2. Mise à jour de l'IMEI sur le véhicule cible
    await api().call('unit/update_device_type', {
      itemId: unit.id,
      deviceTypeId: targetHwId,
      uniqueId: cleanNewImei
    });

    unit.imei = cleanNewImei;
    unit.hwId = targetHwId;

    // 3. Archivage automatique dans les champs administratifs du véhicule cible
    const history = getUnitSwapHistory(unit);
    history.unshift({
      date: effectiveDate,
      oldImei: oldImei || 'Non renseigné',
      newImei: cleanNewImei,
      reason: reason || (freedUnitName ? `Récupéré depuis ${freedUnitName}` : 'Remplacement boîtier'),
      by: userName || 'Admin'
    });

    const adminUpdates = [
      buildFieldUpdateCall(unit.raw, 'ancien_imei', oldImei || 'Aucun', 'aflds'),
      buildFieldUpdateCall(unit.raw, 'date_dernier_swap', effectiveDate, 'aflds'),
      buildFieldUpdateCall(unit.raw, SWAP_HISTORY_FIELD, JSON.stringify(history.slice(0, 20)), 'aflds')
    ].filter(Boolean);

    if (adminUpdates.length) {
      const resList = await api().batch(adminUpdates.map(c => ({ svc: c.svc, params: c.params })));
      resList.forEach((r, idx) => {
        if (!r || !r.error) applyLocalFieldMutation(adminUpdates[idx]._meta, r);
      });
    }

    return {
      oldImei,
      newImei: cleanNewImei,
      swapDate: effectiveDate,
      freedUnitName,
      history
    };
  }

  window.AdminEngine = {
    DEFAULT_SCHEMA,
    normalizeKey,
    findFieldEntry,
    parseBoolValue,
    getFieldRawValue,
    evaluatePermission,
    validateFieldValue,
    getMissingRequiredFields,
    loadAllData,
    updateFieldOnEntities,
    saveSchema,
    getUnitSwapHistory,
    replaceUnitImei
  };
})();
