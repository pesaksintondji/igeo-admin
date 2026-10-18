/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOTEUR D'ADMINISTRATION IGEO — PERMISSIONS, CHAMPS TYPÉS & ANTI-DOUBLONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * - Auto-découverte O(N) en mémoire de tous les champs existants dans Wialon
 *   (aflds et flds), y compris "client", "date d'installation", "technicien", etc.
 * - Normalisation canonique (O(1)) empêchant toute création de champ en double
 *   (insensible à la casse, aux accents, aux apostrophes et aux espaces/underscores).
 * - Suppression automatique des doublons existants sur une même unité lors d'une
 *   mise à jour + outil d'unification en 1 clic.
 * - Validation stricte des types + pile d'annulation (Undo) en mémoire sans coût serveur.
 */
(function () {
  const api = () => window.IgeoApi;

  const UNIT_FLAGS = 0x1 | 0x8 | 0x80 | 0x100 | 0x1000 | 0x2000 | 0x800000;
  const GROUP_FLAGS = 0x1 | 0x8 | 0x80;
  const USER_FLAGS = 0x1 | 0x8 | 0x80;
  const RES_FLAGS = 0x1 | 0x8 | 0x80;

  const SCHEMA_FIELD_NAME = '_igeo_admin_schema_v1';
  const SWAP_HISTORY_FIELD = '_igeo_swap_history';
  const LOCAL_SCHEMA_KEY = 'igeo_admin_schema_cache_v2';

  const INTERNAL_FIELDS = new Set([
    SCHEMA_FIELD_NAME.toLowerCase(),
    SWAP_HISTORY_FIELD.toLowerCase(),
    'note_transfert_boitier'
  ]);

  const DEFAULT_SCHEMA = [
    {
      key: 'ecodrive',
      canonicalName: 'ecodrive',
      label: 'Éco-conduite (EC04)',
      description: 'Active le véhicule ou le groupe dans le rapport Éco-conduite EC04',
      type: 'boolean',
      targets: ['unit', 'group'],
      required: false,
      visibleInMatrix: true,
      icon: 'eco',
      color: '#16a34a',
      storage: 'aflds',
      category: 'permission',
      system: true
    },
    {
      key: 'carburant',
      canonicalName: 'carburant',
      label: 'Carburant (V20)',
      description: 'Active le véhicule ou le groupe dans le rapport Gestion Carburant V20',
      type: 'boolean',
      targets: ['unit', 'group'],
      required: false,
      visibleInMatrix: true,
      icon: 'local_gas_station',
      color: '#2563eb',
      storage: 'aflds',
      category: 'permission',
      system: true
    },
    {
      key: 'client',
      canonicalName: 'client',
      label: 'Client',
      description: 'Client propriétaire ou affectataire de la balise',
      type: 'text',
      targets: ['unit', 'group'],
      required: true,
      visibleInMatrix: true,
      icon: 'business',
      color: '#0f766e',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'date_installation',
      canonicalName: "Date d'installation",
      label: 'Date d’installation',
      description: 'Date de pose de la balise GPS (format date validé)',
      type: 'date',
      targets: ['unit'],
      required: true,
      visibleInMatrix: true,
      icon: 'event_available',
      color: '#0284c7',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'technicien',
      canonicalName: 'technicien',
      label: 'Technicien',
      description: 'Technicien ayant réalisé l’installation ou l’intervention',
      type: 'text',
      targets: ['unit'],
      required: true,
      visibleInMatrix: true,
      icon: 'engineering',
      color: '#b45309',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'coupure_moteur',
      canonicalName: 'coupure_moteur',
      label: 'Coupure moteur autorisée',
      description: 'Autorise l’utilisateur ou le véhicule à exécuter une coupure moteur à distance',
      type: 'boolean',
      targets: ['user', 'unit', 'group'],
      required: false,
      visibleInMatrix: true,
      icon: 'power_settings_new',
      color: '#dc2626',
      storage: 'aflds',
      category: 'permission',
      system: false
    },
    {
      key: 'rapport_journalier',
      canonicalName: 'rapport_journalier',
      label: 'Reçoit Rapport Journalier',
      description: 'Active l’accès ou l’envoi du rapport journalier V13',
      type: 'boolean',
      targets: ['user', 'group', 'unit'],
      required: false,
      visibleInMatrix: true,
      icon: 'forward_to_inbox',
      color: '#7c3aed',
      storage: 'aflds',
      category: 'permission',
      system: false
    },
    {
      key: 'ancien_imei',
      canonicalName: 'ancien_imei',
      label: 'Ancien IMEI',
      description: 'Identifiant du précédent boîtier (archivé automatiquement lors d’un swap)',
      type: 'text',
      targets: ['unit'],
      required: false,
      visibleInMatrix: false,
      icon: 'history',
      color: '#64748b',
      storage: 'aflds',
      category: 'field',
      system: false
    },
    {
      key: 'date_dernier_swap',
      canonicalName: 'date_dernier_swap',
      label: 'Date dernier Swap',
      description: 'Date du dernier remplacement d’IMEI sur ce véhicule',
      type: 'date',
      targets: ['unit'],
      required: false,
      visibleInMatrix: false,
      icon: 'swap_horiz',
      color: '#d97706',
      storage: 'aflds',
      category: 'field',
      system: false
    }
  ];

  /**
   * Clé technique snake_case propre (ex: "Date d'installation" -> "date_installation")
   */
  function normalizeKey(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(d|l|de|du|des)\s*['’]/gi, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Empreinte canonique stricte O(1) pour détecter les doublons :
   * "Date d'installation", "date_installation", "DATE INSTALLATION", "date d installation"
   * produisent TOUS exactement "dateinstallation" !
   */
  function canonicalToken(str) {
    const raw = String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    // Supprimer les articles d'élision courants ("d'", "l'") pour que "date d'installation" == "date_installation"
    const withoutElision = raw.replace(/\b[dl]['’\s_]+/g, '');
    return withoutElision.replace(/[^a-z0-9]/g, '');
  }

  function getCanonicalAliases(fieldKeyOrName) {
    const tok = canonicalToken(fieldKeyOrName);
    const set = new Set([tok]);
    if (tok === 'carburant' || tok === 'fuel') {
      set.add('carburant');
      set.add('fuel');
    }
    if (tok === 'ecodrive' || tok === 'ecoconduite') {
      set.add('ecodrive');
      set.add('ecoconduite');
    }
    if (tok === 'dateinstallation' || tok === 'datedinstallation') {
      set.add('dateinstallation');
      set.add('datedinstallation');
    }
    return set;
  }

  /**
   * Retourne TOUTES les entrées correspondantes dans aflds et flds pour une entité
   * (permet de détecter s'il y a déjà des doublons sur la même fiche Wialon !)
   */
  function findAllMatchingEntries(rawItem, fieldKey, preferredStorage = 'aflds') {
    if (!rawItem) return [];
    const targetTokens = getCanonicalAliases(fieldKey);
    const dicts = preferredStorage === 'flds'
      ? [['flds', rawItem.flds], ['aflds', rawItem.aflds]]
      : [['aflds', rawItem.aflds], ['flds', rawItem.flds]];

    const matches = [];
    for (const [dictName, dict] of dicts) {
      if (!dict) continue;
      for (const entry of Object.values(dict)) {
        if (!entry || !entry.n) continue;
        if (targetTokens.has(canonicalToken(entry.n))) {
          matches.push({
            id: entry.id,
            name: entry.n,
            value: entry.v != null ? String(entry.v).trim() : '',
            dictName
          });
        }
      }
    }
    return matches;
  }

  function findFieldEntry(rawItem, fieldKey, storage = 'aflds') {
    const all = findAllMatchingEntries(rawItem, fieldKey, storage);
    if (!all.length) return null;
    // Prioriser l'entrée non vide si plusieurs doublons existent
    return all.find(e => e.value !== '') || all[0];
  }

  function parseBoolValue(rawVal) {
    if (rawVal == null) return null;
    const v = canonicalToken(rawVal);
    if (!v) return null;
    if (/^(oui|yes|1|true|vrai|actif|active|ok|exploitable)$/.test(v)) return true;
    if (/^(non|no|0|false|faux|inactif|inactive)$/.test(v)) return false;
    return null;
  }

  /**
   * Convertit une date JJ/MM/AAAA ou AAAA/MM/JJ en AAAA-MM-JJ standard
   */
  function normalizeDateString(rawVal) {
    const str = String(rawVal == null ? '' : rawVal).trim();
    if (!str) return '';
    // Déjà AAAA-MM-JJ
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    // Format français JJ/MM/AAAA ou JJ-MM-AAAA
    const frMatch = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(str);
    if (frMatch) {
      const dd = frMatch[1].padStart(2, '0');
      const mm = frMatch[2].padStart(2, '0');
      const yyyy = frMatch[3];
      return `${yyyy}-${mm}-${dd}`;
    }
    return str;
  }

  function getFieldRawValue(entity, fieldDef) {
    const entry = findFieldEntry(entity.raw, fieldDef.key, fieldDef.storage);
    if (!entry) return '';
    if (fieldDef.type === 'date') {
      return normalizeDateString(entry.value);
    }
    return entry.value;
  }

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
        own,
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
      const norm = normalizeDateString(str);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
        return { valid: false, reason: `Le champ « ${fieldDef.label} » n'accepte qu'une date valide (ex: 2026-10-18).` };
      }
      const d = new Date(norm + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) {
        return { valid: false, reason: `Date calendrier invalide pour « ${fieldDef.label} ».` };
      }
      return { valid: true, normalized: norm };
    }

    if (fieldDef.type === 'number') {
      const num = Number(str.replace(',', '.'));
      if (!Number.isFinite(num)) {
        return { valid: false, reason: `Le champ « ${fieldDef.label} » n'accepte que des nombres.` };
      }
      return { valid: true, normalized: String(num) };
    }

    if (fieldDef.type === 'select') {
      const opts = Array.isArray(fieldDef.options) ? fieldDef.options : [];
      if (opts.length && !opts.includes(str)) {
        return { valid: false, reason: `Valeur « ${str} » non autorisée. Choisissez parmi : ${opts.join(', ')}.` };
      }
      return { valid: true, normalized: str };
    }

    return { valid: true, normalized: str };
  }

  function getMissingRequiredFields(entity, schema) {
    const relevant = schema.filter(f => f.required && Array.isArray(f.targets) && f.targets.includes(entity.entityType));
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
    const byToken = new Map();
    for (const d of DEFAULT_SCHEMA) {
      byToken.set(canonicalToken(d.key), { ...d });
    }
    if (Array.isArray(customList)) {
      for (const item of customList) {
        if (!item || !item.key) continue;
        const tok = canonicalToken(item.key);
        if (!tok) continue;
        const existing = byToken.get(tok);
        byToken.set(tok, {
          ...(existing || {}),
          ...item,
          key: existing ? existing.key : normalizeKey(item.key),
          canonicalName: item.canonicalName || (existing && existing.canonicalName) || item.key,
          visibleInMatrix: item.visibleInMatrix !== undefined ? item.visibleInMatrix : true,
          system: existing ? existing.system : false
        });
      }
    }
    return [...byToken.values()];
  }

  /**
   * Inférence automatique du type d'un champ existant dans Wialon à partir de ses valeurs
   */
  function inferFieldTypeFromValues(fieldName, values) {
    const nonEmpty = values.filter(Boolean);
    const tok = canonicalToken(fieldName);
    if (tok.includes('date')) return 'date';
    if (!nonEmpty.length) return 'text';
    if (nonEmpty.every(v => parseBoolValue(v) !== null)) return 'boolean';
    if (nonEmpty.every(v => /^\d{4}-\d{2}-\d{2}$/.test(normalizeDateString(v)))) return 'date';
    return 'text';
  }

  /**
   * Scanne en O(N) tous les champs aflds et flds déjà présents sur les véhicules, groupes et utilisateurs :
   * 1. Ajoute automatiquement au schéma tout champ existant dans Wialon (ex: client, technicien, date d'installation, etc.).
   * 2. Collecte les valeurs distinctes existantes (pour auto-complétion / listes déroulantes sans faute de frappe).
   * 3. Détecte les doublons ou variantes d'écriture (ex: "Technicien" vs "technicien", ou 2 entrées sur la même unité).
   */
  function discoverExistingFieldsAndStats(schema, units, groups, users) {
    const byToken = new Map();
    for (const f of schema) {
      const tok = canonicalToken(f.key);
      byToken.set(tok, {
        ...f,
        discoveredNames: new Set([f.canonicalName || f.key]),
        discoveredValues: new Set(),
        filledCount: 0,
        duplicateUnitsCount: 0
      });
      // Enregistrer aussi les alias canoniques
      for (const al of getCanonicalAliases(f.key)) {
        if (!byToken.has(al)) byToken.set(al, byToken.get(tok));
      }
    }

    const scanEntities = (entities, entityType) => {
      for (const ent of entities) {
        const seenTokensOnThisEntity = new Map();
        for (const dictName of ['aflds', 'flds']) {
          const dict = ent.raw && ent.raw[dictName];
          if (!dict) continue;
          for (const entry of Object.values(dict)) {
            if (!entry || !entry.n) continue;
            const rawName = String(entry.n).trim();
            if (!rawName || INTERNAL_FIELDS.has(rawName.toLowerCase()) || rawName.startsWith('_igeo_')) continue;

            const tok = canonicalToken(rawName);
            if (!tok) continue;

            let fieldMeta = byToken.get(tok);
            if (!fieldMeta) {
              // Nouveau champ découvert automatiquement depuis Wialon !
              const cleanKey = normalizeKey(rawName) || tok;
              fieldMeta = {
                key: cleanKey,
                canonicalName: rawName,
                label: rawName.charAt(0).toUpperCase() + rawName.slice(1).replace(/_/g, ' '),
                description: `Champ existant détecté dans Wialon (${dictName === 'aflds' ? 'Administratif' : 'Personnalisé'})`,
                type: 'text',
                targets: [entityType],
                required: false,
                visibleInMatrix: true,
                icon: dictName === 'aflds' ? 'admin_panel_settings' : 'label',
                color: '#0284c7',
                storage: dictName,
                category: 'field',
                system: false,
                autoDiscovered: true,
                discoveredNames: new Set([rawName]),
                discoveredValues: new Set(),
                filledCount: 0,
                duplicateUnitsCount: 0
              };
              byToken.set(tok, fieldMeta);
            } else {
              fieldMeta.discoveredNames.add(rawName);
              if (Array.isArray(fieldMeta.targets) && !fieldMeta.targets.includes(entityType)) {
                fieldMeta.targets.push(entityType);
              }
            }

            // Détecter si cette même unité possède deux fois ce même champ (doublon sur l'unité)
            const prevCount = seenTokensOnThisEntity.get(tok) || 0;
            seenTokensOnThisEntity.set(tok, prevCount + 1);
            if (prevCount === 1) {
              fieldMeta.duplicateUnitsCount += 1;
            }

            const val = entry.v != null ? String(entry.v).trim() : '';
            if (val) {
              fieldMeta.filledCount += 1;
              if (fieldMeta.discoveredValues.size < 200) {
                fieldMeta.discoveredValues.add(val);
              }
            }
          }
        }
      }
    };

    scanEntities(units, 'unit');
    scanEntities(groups, 'group');
    scanEntities(users, 'user');

    // Dédupliquer la liste finale des définitions
    const uniqueFields = [];
    const seenFinal = new Set();
    for (const meta of byToken.values()) {
      if (seenFinal.has(meta.key)) continue;
      seenFinal.add(meta.key);

      const valuesArr = [...meta.discoveredValues].sort((a, b) => a.localeCompare(b, 'fr'));
      const namesArr = [...meta.discoveredNames];

      // Si le champ vient d'être auto-découvert, inférer son type (date, boolean, text)
      if (meta.autoDiscovered) {
        meta.type = inferFieldTypeFromValues(meta.key, valuesArr);
        if (meta.type === 'boolean') {
          meta.category = 'permission';
          meta.icon = 'toggle_on';
        } else if (meta.type === 'date') {
          meta.icon = 'event';
        }
      }

      // Conserver le nom exact tel qu'il est déjà utilisé dans Wialon pour éviter de créer un doublon
      if (namesArr.length === 1) {
        meta.canonicalName = namesArr[0];
      }

      uniqueFields.push({
        ...meta,
        discoveredNames: namesArr,
        discoveredValues: valuesArr
      });
    }

    return uniqueFields;
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
      const serializable = schema.map(f => ({
        key: f.key,
        canonicalName: f.canonicalName || f.key,
        label: f.label,
        description: f.description,
        type: f.type,
        options: f.options,
        targets: f.targets,
        required: !!f.required,
        visibleInMatrix: f.visibleInMatrix !== false,
        icon: f.icon,
        color: f.color,
        storage: f.storage || 'aflds',
        category: f.category || (f.type === 'boolean' ? 'permission' : 'field'),
        system: !!f.system
      }));
      localStorage.setItem(LOCAL_SCHEMA_KEY, JSON.stringify(serializable));
    } catch (_e) {}
  }

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

    const resources = (resRes && resRes.items) || [];
    resources.sort((a, b) => {
      const aPri = /3dt|3dtech|igeo/i.test(a.nm || '') ? 1 : 0;
      const bPri = /3dt|3dtech|igeo/i.test(b.nm || '') ? 1 : 0;
      return bPri - aPri;
    });
    const primaryResource = resources[0] || null;

    let baseSchema = loadCachedSchema();
    if (primaryResource) {
      const schemaEntry = findFieldEntry(primaryResource, SCHEMA_FIELD_NAME, 'aflds');
      if (schemaEntry && schemaEntry.value) {
        try {
          baseSchema = mergeSchemaWithDefaults(JSON.parse(schemaEntry.value));
        } catch (_e) {}
      }
    }

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

    // Auto-découverte O(N) de tous les champs existants (client, technicien, date d'installation, etc.)
    const schema = discoverExistingFieldsAndStats(baseSchema, units, groups, users);
    saveCachedSchema(schema);

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
   * Construit le ou les appels Wialon pour mettre à jour un champ SANS JAMAIS créer de doublon :
   * - Réutilise l'entrée existante (même si son nom avait des majuscules/accents/espaces différents),
   * - Supprime automatiquement les éventuels doublons surnuméraires présents sur cette même unité.
   */
  function buildFieldUpdateCalls(rawItem, fieldDefOrKey, newValue, storage = 'aflds') {
    const fieldKey = typeof fieldDefOrKey === 'object' ? fieldDefOrKey.key : fieldDefOrKey;
    const preferredName = (typeof fieldDefOrKey === 'object' && fieldDefOrKey.canonicalName)
      ? fieldDefOrKey.canonicalName
      : fieldKey;
    const targetStorage = (typeof fieldDefOrKey === 'object' && fieldDefOrKey.storage)
      ? fieldDefOrKey.storage
      : storage;

    const allMatches = findAllMatchingEntries(rawItem, fieldKey, targetStorage);
    const strVal = newValue == null ? '' : String(newValue).trim();
    const calls = [];

    if (!strVal) {
      // Suppression de toutes les occurrences de ce champ sur l'entité
      for (const m of allMatches) {
        const svc = m.dictName === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
        calls.push({
          svc,
          params: { itemId: rawItem.id, id: m.id, callMode: 'delete' },
          _meta: { rawItem, fieldKey, strVal: '', storage: m.dictName, mode: 'delete', oldId: m.id }
        });
      }
      return calls;
    }

    if (allMatches.length > 0) {
      // Mettre à jour la première entrée existante (en conservant son dictName ou en normalisant son nom)
      const primary = allMatches[0];
      const primarySvc = primary.dictName === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
      calls.push({
        svc: primarySvc,
        params: {
          itemId: rawItem.id,
          id: primary.id,
          callMode: 'update',
          n: preferredName || primary.name,
          v: strVal
        },
        _meta: {
          rawItem,
          fieldKey: preferredName || primary.name,
          strVal,
          storage: primary.dictName,
          mode: 'update',
          oldId: primary.id
        }
      });

      // Nettoyer automatiquement tout doublon surnuméraire sur cette même unité !
      for (let i = 1; i < allMatches.length; i++) {
        const dup = allMatches[i];
        const dupSvc = dup.dictName === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
        calls.push({
          svc: dupSvc,
          params: { itemId: rawItem.id, id: dup.id, callMode: 'delete' },
          _meta: { rawItem, fieldKey: dup.name, strVal: '', storage: dup.dictName, mode: 'delete', oldId: dup.id }
        });
      }
      return calls;
    }

    // Aucune entrée existante : création unique avec le nom canonique
    const createSvc = targetStorage === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
    calls.push({
      svc: createSvc,
      params: {
        itemId: rawItem.id,
        id: 0,
        callMode: 'create',
        n: preferredName,
        v: strVal
      },
      _meta: { rawItem, fieldKey: preferredName, strVal, storage: targetStorage, mode: 'create' }
    });
    return calls;
  }

  function applyLocalFieldMutation(meta, resItem) {
    const dictKey = meta.storage === 'flds' ? 'flds' : 'aflds';
    if (!meta.rawItem[dictKey]) meta.rawItem[dictKey] = {};
    const dict = meta.rawItem[dictKey];

    if (meta.mode === 'delete') {
      for (const [k, v] of Object.entries(dict)) {
        if (v && (v.id === meta.oldId || canonicalToken(v.n) === canonicalToken(meta.fieldKey))) {
          delete dict[k];
        }
      }
      return;
    }

    if (Array.isArray(resItem) && resItem[1] && typeof resItem[1] === 'object') {
      const fObj = resItem[1];
      dict[String(fObj.id)] = { id: fObj.id, n: fObj.n || meta.fieldKey, v: meta.strVal };
      return;
    }

    const fallbackId = meta.oldId || Date.now() % 100000;
    dict[String(fallbackId)] = { id: fallbackId, n: meta.fieldKey, v: meta.strVal };
  }

  // Pile d'annulation (Undo) en mémoire (coût 0)
  const undoStack = [];

  function canUndo() {
    return undoStack.length > 0;
  }

  function peekUndo() {
    return undoStack[undoStack.length - 1] || null;
  }

  async function updateFieldOnEntities(entities, fieldDef, rawNewValue, recordUndo = true) {
    let strVal = rawNewValue == null ? '' : String(rawNewValue).trim();
    if (strVal !== '') {
      const check = validateFieldValue(fieldDef, strVal);
      if (!check.valid) {
        throw new Error(check.reason);
      }
      strVal = check.normalized;
    }

    const previousSnapshot = [];
    const callsWithMeta = [];

    for (const ent of entities) {
      const prevVal = getFieldRawValue(ent, fieldDef);
      if (prevVal === strVal) continue;
      previousSnapshot.push({ entity: ent, previousValue: prevVal });
      const entCalls = buildFieldUpdateCalls(ent.raw, fieldDef, strVal, fieldDef.storage || 'aflds');
      callsWithMeta.push(...entCalls);
    }

    if (!callsWithMeta.length) return { updated: 0 };

    const batchPayload = callsWithMeta.map(c => ({ svc: c.svc, params: c.params }));
    const results = await api().batchChunked(batchPayload);

    const errors = [];
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

    if (recordUndo && previousSnapshot.length) {
      undoStack.push({
        label: `${fieldDef.label} (${previousSnapshot.length} élément${previousSnapshot.length > 1 ? 's' : ''})`,
        fieldDef,
        snapshot: previousSnapshot,
        timestamp: Date.now()
      });
      if (undoStack.length > 15) undoStack.shift();
    }

    return { updated: previousSnapshot.length };
  }

  async function undoLastAction() {
    const last = undoStack.pop();
    if (!last) return null;

    const callsWithMeta = [];
    for (const item of last.snapshot) {
      const entCalls = buildFieldUpdateCalls(item.entity.raw, last.fieldDef, item.previousValue, last.fieldDef.storage || 'aflds');
      callsWithMeta.push(...entCalls);
    }

    if (callsWithMeta.length) {
      const results = await api().batchChunked(callsWithMeta.map(c => ({ svc: c.svc, params: c.params })));
      results.forEach((res, idx) => {
        if (!res || !res.error) applyLocalFieldMutation(callsWithMeta[idx]._meta, res);
      });
    }
    return last;
  }

  /**
   * Unifie en 1 clic toutes les variantes d'écriture et supprime les doublons d'un champ sur tout le parc
   */
  async function unifyAndDeduplicateField(fieldDef, allEntities) {
    const callsWithMeta = [];
    let touchedEntities = 0;

    for (const ent of allEntities) {
      const matches = findAllMatchingEntries(ent.raw, fieldDef.key, fieldDef.storage || 'aflds');
      if (!matches.length) continue;

      const needsUnify = matches.length > 1 || matches[0].name !== (fieldDef.canonicalName || fieldDef.key);
      if (!needsUnify) continue;

      const bestVal = (matches.find(m => m.value !== '') || matches[0]).value;
      const check = validateFieldValue(fieldDef, bestVal);
      const finalVal = check.valid ? check.normalized : bestVal;

      const entCalls = buildFieldUpdateCalls(ent.raw, fieldDef, finalVal, fieldDef.storage || 'aflds');
      if (entCalls.length) {
        callsWithMeta.push(...entCalls);
        touchedEntities++;
      }
    }

    if (!callsWithMeta.length) return { cleaned: 0 };

    const results = await api().batchChunked(callsWithMeta.map(c => ({ svc: c.svc, params: c.params })));
    results.forEach((res, idx) => {
      if (!res || !res.error) applyLocalFieldMutation(callsWithMeta[idx]._meta, res);
    });

    return { cleaned: touchedEntities };
  }

  async function saveSchema(schema, primaryResource, units = [], groups = [], users = []) {
    const merged = discoverExistingFieldsAndStats(mergeSchemaWithDefaults(schema), units, groups, users);
    saveCachedSchema(merged);

    if (primaryResource) {
      const serializable = merged.map(f => ({
        key: f.key,
        canonicalName: f.canonicalName || f.key,
        label: f.label,
        description: f.description,
        type: f.type,
        options: f.options,
        targets: f.targets,
        required: !!f.required,
        visibleInMatrix: f.visibleInMatrix !== false,
        icon: f.icon,
        color: f.color,
        storage: f.storage || 'aflds',
        category: f.category,
        system: !!f.system
      }));
      const calls = buildFieldUpdateCalls(primaryResource, SCHEMA_FIELD_NAME, JSON.stringify(serializable), 'aflds');
      if (calls.length) {
        try {
          const [res] = await api().batch([{ svc: calls[0].svc, params: calls[0].params }]);
          if (!res || !res.error) applyLocalFieldMutation(calls[0]._meta, res);
        } catch (e) {
          console.warn('[AdminEngine] Sauvegarde distante du schéma ignorée :', e);
        }
      }
    }
    return merged;
  }

  function getUnitSwapHistory(unit) {
    const entry = findFieldEntry(unit.raw, SWAP_HISTORY_FIELD, 'aflds');
    if (entry && entry.value) {
      try {
        const list = JSON.parse(entry.value);
        if (Array.isArray(list)) return list;
      } catch (_e) {}
    }
    const oldImei = getFieldRawValue(unit, { key: 'ancien_imei', storage: 'aflds' });
    const lastDate = getFieldRawValue(unit, { key: 'date_dernier_swap', storage: 'aflds', type: 'date' });
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

      const noteCalls = buildFieldUpdateCalls(
        conflictUnit.raw,
        'note_transfert_boitier',
        `Boîtier ${cleanNewImei} transféré vers ${unit.name} le ${effectiveDate}`,
        'aflds'
      );
      if (noteCalls.length) {
        const [r] = await api().batch([{ svc: noteCalls[0].svc, params: noteCalls[0].params }]);
        if (!r || !r.error) applyLocalFieldMutation(noteCalls[0]._meta, r);
      }
    }

    await api().call('unit/update_device_type', {
      itemId: unit.id,
      deviceTypeId: targetHwId,
      uniqueId: cleanNewImei
    });

    unit.imei = cleanNewImei;
    unit.hwId = targetHwId;

    const history = getUnitSwapHistory(unit);
    history.unshift({
      date: effectiveDate,
      oldImei: oldImei || 'Non renseigné',
      newImei: cleanNewImei,
      reason: reason || (freedUnitName ? `Récupéré depuis ${freedUnitName}` : 'Remplacement boîtier'),
      by: userName || 'Admin'
    });

    const adminUpdates = [
      ...buildFieldUpdateCalls(unit.raw, 'ancien_imei', oldImei || 'Aucun', 'aflds'),
      ...buildFieldUpdateCalls(unit.raw, 'date_dernier_swap', effectiveDate, 'aflds'),
      ...buildFieldUpdateCalls(unit.raw, SWAP_HISTORY_FIELD, JSON.stringify(history.slice(0, 20)), 'aflds')
    ];

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
    canonicalToken,
    findFieldEntry,
    findAllMatchingEntries,
    parseBoolValue,
    getFieldRawValue,
    evaluatePermission,
    validateFieldValue,
    getMissingRequiredFields,
    loadAllData,
    updateFieldOnEntities,
    canUndo,
    peekUndo,
    undoLastAction,
    unifyAndDeduplicateField,
    saveSchema,
    getUnitSwapHistory,
    replaceUnitImei
  };
})();
