/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOTEUR D'ADMINISTRATION IGEO — PERMISSIONS, RÔLES, COMMANDES & COMPTES CMS
 * ═══════════════════════════════════════════════════════════════════════════════
 * - Entités gérées :
 *     1. Véhicules (avl_unit) + leurs commandes configurées (0x400000 = cmds)
 *     2. Groupes de véhicules (avl_unit_group)
 *     3. Utilisateurs (user) avec Type d'utilisateur : Technicien, Support, Client
 *     4. Comptes & Ressources CMS (avl_resource)
 * - Gestion matricielle des Commandes (Voir / Modifier / Lancer) selon le
 *   Type d'utilisateur (Technicien, Support, Client) avec héritage du rôle et
 *   surcharge possible par utilisateur individuel.
 * - Auto-découverte O(N) de tous les champs existants sur Véhicules, Groupes,
 *   Utilisateurs et Comptes/Ressources CMS + anti-doublon canonique O(1) + Undo.
 */
(function () {
  const api = () => window.IgeoApi;

  // 0x400000 = commandes configurées sur l'unité (it.cmds)
  // Sans 0x1000 (tables capteurs) ni 0x2000/0x800000 pour accélérer le chargement x6 sur les grands parcs
  const UNIT_FLAGS = 0x1 | 0x8 | 0x80 | 0x100 | 0x400000;
  const GROUP_FLAGS = 0x1 | 0x8 | 0x80;
  const USER_FLAGS = 0x1 | 0x4 | 0x8 | 0x80;
  const RES_FLAGS = 0x1 | 0x4 | 0x8 | 0x80;

  const SCHEMA_FIELD_NAME = '_igeo_admin_schema_v1';
  const CMD_POLICY_FIELD_NAME = '_igeo_cmd_policies_v1';
  const USER_CMD_OVERRIDE_FIELD = '_igeo_user_cmd_acl';
  const SWAP_HISTORY_FIELD = '_igeo_swap_history';

  const LOCAL_SCHEMA_KEY = 'igeo_admin_schema_cache_v5';
  const LOCAL_CMD_POLICY_KEY = 'igeo_admin_cmd_policies_cache_v1';
  const LOCAL_HW_TYPES_KEY = 'igeo_admin_hw_types_cache_v1';

  const USER_ROLES = ['Technicien', 'Support', 'Client'];

  // Permissions critiques dupliquées dans aflds ET flds pour compatibilité immédiate avec rapports.igeopilot.com (tokens 0x300 et sous-comptes clients)
  const MIRRORED_PERMISSION_KEYS = new Set([
    'ecodrive',
    'carburant',
    'coupure_moteur',
    'rapport_journalier',
    'fuel_sensor_floor',
    'fuelsensorfloor',
    'seuil_plancher',
    'seuilplancher',
    'plafond',
    'plafond_carburant',
    'plafondcarburant',
    'seuilplafond',
    'plancher',
    'fuelfloor'
  ]);

  const INTERNAL_FIELDS = new Set([
    SCHEMA_FIELD_NAME.toLowerCase(),
    CMD_POLICY_FIELD_NAME.toLowerCase(),
    USER_CMD_OVERRIDE_FIELD.toLowerCase(),
    SWAP_HISTORY_FIELD.toLowerCase(),
    'note_transfert_boitier',
    'commandes_resume',
    '_igeo_grp_ecodrive',
    '_igeo_grp_carburant'
  ]);

  // Catalogue de commandes de base (complété automatiquement par les commandes réelles it.cmds des véhicules)
  const DEFAULT_COMMANDS = [
    {
      key: 'cmd_coupure_moteur',
      name: 'Coupure moteur / Immobilisation',
      category: 'Sécurité',
      icon: 'power_settings_new',
      color: '#dc2626',
      description: 'Arrêt moteur à distance / activation relais immobilisation'
    },
    {
      key: 'cmd_reprise_moteur',
      name: 'Reprise moteur / Autoriser démarrage',
      category: 'Sécurité',
      icon: 'play_circle',
      color: '#16a34a',
      description: 'Désactivation de la coupure moteur et remise en route'
    },
    {
      key: 'cmd_position',
      name: 'Demande de position (Ping GPS)',
      category: 'Diagnostic',
      icon: 'my_location',
      color: '#2563eb',
      description: 'Interrogation immédiate de la position actuelle du boîtier'
    },
    {
      key: 'cmd_reboot',
      name: 'Redémarrage boîtier (Reboot)',
      category: 'Maintenance',
      icon: 'restart_alt',
      color: '#d97706',
      description: 'Redémarrage logiciel à distance de la balise GPS'
    },
    {
      key: 'cmd_config_ota',
      name: 'Configuration APN / Serveur / OTA',
      category: 'Technique',
      icon: 'settings_input_antenna',
      color: '#7c3aed',
      description: 'Envoi de paramètres réseau ou firmware à la balise'
    }
  ];

  // Droits par défaut (Voir / Modifier / Lancer) selon le Type d'utilisateur
  function defaultRoleCommandPolicies(commands) {
    const policies = {
      Technicien: {},
      Support: {},
      Client: {}
    };
    for (const cmd of commands) {
      const isTechOnly = cmd.category === 'Technique' || /config|apn|ota|param|fw|firmware/i.test(cmd.name);
      const isMaint = cmd.category === 'Maintenance' || /reboot|reset/i.test(cmd.name);

      // Technicien : peut voir, modifier et lancer toutes les commandes
      policies.Technicien[cmd.key] = { view: true, edit: true, exec: true };

      // Support : peut voir et lancer les commandes opérationnelles/diagnostic/maintenance, sans modifier la config
      policies.Support[cmd.key] = {
        view: true,
        edit: false,
        exec: !isTechOnly
      };

      // Client : peut voir et lancer les commandes de sécurité/position si autorisé, jamais modifier ni toucher au technique
      policies.Client[cmd.key] = {
        view: !isTechOnly && !isMaint,
        edit: false,
        exec: !isTechOnly && !isMaint
      };
    }
    return policies;
  }

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
      key: 'groupe_multi_client',
      canonicalName: 'groupe_multi_client',
      label: 'Groupe multi-clients',
      description: 'Écarte le groupe de la colonne « Groupe / Client » des rapports (PR01, V02). Vide = détection automatique',
      type: 'boolean',
      targets: ['group'],
      required: false,
      visibleInMatrix: true,
      icon: 'hub',
      color: '#7c3aed',
      storage: 'aflds',
      category: 'field',
      system: true
    },
    {
      key: 'client_spa',
      canonicalName: 'client_spa',
      label: 'Client (SPA)',
      description: 'Compte(s) client de la SPA qui ont choisi ce groupe. Recopié chaque heure par le cron de la SPA : à modifier dans la SPA',
      type: 'text',
      targets: ['group'],
      required: false,
      visibleInMatrix: true,
      readOnly: true,
      icon: 'business',
      color: '#0f766e',
      storage: 'aflds',
      category: 'field',
      system: true
    },
    {
      key: 'fuel_sensor_floor',
      canonicalName: 'fuel_sensor_floor',
      label: 'Plafond / Seuil plancher (L)',
      description: 'Seuil mécanique en litres sous lequel le capteur de carburant plafonne (modèle relais V20)',
      type: 'number',
      targets: ['unit', 'group'],
      required: false,
      visibleInMatrix: true,
      icon: 'straighten',
      color: '#f59e0b',
      storage: 'aflds',
      category: 'field',
      system: true
    },
    {
      key: 'client',
      canonicalName: 'client',
      label: 'Client',
      description: 'Client propriétaire ou affectataire de la balise / ressource',
      type: 'text',
      targets: ['unit', 'resource'],
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
      key: 'role_utilisateur',
      canonicalName: 'role_utilisateur',
      label: 'Type d’utilisateur',
      description: 'Profil déterminant les droits sur les commandes (Technicien, Support, Client)',
      type: 'select',
      options: USER_ROLES,
      targets: ['user'],
      required: true,
      visibleInMatrix: true,
      icon: 'badge',
      color: '#0284c7',
      storage: 'aflds',
      category: 'field',
      system: true
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
      targets: ['user', 'group', 'unit', 'resource'],
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

  const TOKEN_CACHE = new Map();
  const ALIAS_CACHE = new Map();

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

  function canonicalToken(str) {
    if (str == null || str === '') return '';
    const key = String(str);
    const cached = TOKEN_CACHE.get(key);
    if (cached !== undefined) return cached;
    const raw = key
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    const withoutElision = raw.replace(/\b[dl]['’\s_]+/g, '');
    const res = withoutElision.replace(/[^a-z0-9]/g, '');
    if (TOKEN_CACHE.size < 10000) TOKEN_CACHE.set(key, res);
    return res;
  }

  function getCanonicalAliases(fieldKeyOrName) {
    const tok = canonicalToken(fieldKeyOrName);
    let set = ALIAS_CACHE.get(tok);
    if (set) return set;
    set = new Set([tok]);
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
    if (tok === 'roleutilisateur' || tok === 'typeutilisateur' || tok === 'role') {
      set.add('roleutilisateur');
      set.add('typeutilisateur');
      set.add('role');
    }
    if (
      tok === 'fuelsensorfloor' ||
      tok === 'fuelfloor' ||
      tok === 'sensorfloor' ||
      tok === 'seuilplancher' ||
      tok === 'capteurplancher' ||
      tok === 'plancher' ||
      tok === 'plafond' ||
      tok === 'plafondcarburant' ||
      tok === 'seuilplafond' ||
      tok === 'planchercarburant' ||
      tok === 'fuelsensorfloorliters'
    ) {
      set.add('fuelsensorfloor');
      set.add('fuelfloor');
      set.add('sensorfloor');
      set.add('seuilplancher');
      set.add('capteurplancher');
      set.add('plancher');
      set.add('plafond');
      set.add('plafondcarburant');
      set.add('seuilplafond');
      set.add('planchercarburant');
      set.add('fuel_sensor_floor');
      set.add('seuil_plancher');
    }
    ALIAS_CACHE.set(tok, set);
    return set;
  }

  // Index O(1) par entité brute (évite de boucler sur aflds/flds à chaque cellule de la matrice)
  function ensureRawItemIndex(rawItem) {
    if (!rawItem) return null;
    if (rawItem._idx) return rawItem._idx;
    const idx = { aflds: new Map(), flds: new Map() };
    for (const dictName of ['aflds', 'flds']) {
      const dict = rawItem[dictName];
      if (!dict) continue;
      const targetMap = idx[dictName];
      for (const entry of Object.values(dict)) {
        if (!entry || !entry.n) continue;
        const tok = canonicalToken(entry.n);
        if (!tok) continue;
        let arr = targetMap.get(tok);
        if (!arr) {
          arr = [];
          targetMap.set(tok, arr);
        }
        arr.push({
          id: entry.id,
          name: entry.n,
          value: entry.v != null ? String(entry.v).trim() : '',
          dictName
        });
      }
    }
    rawItem._idx = idx;
    return idx;
  }

  function findAllMatchingEntries(rawItem, fieldKey, preferredStorage = 'aflds') {
    if (!rawItem) return [];
    const idx = ensureRawItemIndex(rawItem);
    const targetTokens = getCanonicalAliases(fieldKey);
    const order = preferredStorage === 'flds' ? ['flds', 'aflds'] : ['aflds', 'flds'];

    const matches = [];
    for (const dictName of order) {
      const map = idx[dictName];
      for (const tok of targetTokens) {
        const list = map.get(tok);
        if (list && list.length) {
          for (let i = 0; i < list.length; i++) matches.push(list[i]);
        }
      }
    }
    return matches;
  }

  function findFieldEntry(rawItem, fieldKey, storage = 'aflds') {
    const all = findAllMatchingEntries(rawItem, fieldKey, storage);
    if (!all.length) return null;
    for (let i = 0; i < all.length; i++) {
      if (all[i].value !== '') return all[i];
    }
    return all[0];
  }

  function parseBoolValue(rawVal) {
    if (rawVal == null) return null;
    const v = canonicalToken(rawVal);
    if (!v) return null;
    if (/^(oui|yes|1|true|vrai|actif|active|ok|exploitable)$/.test(v)) return true;
    if (/^(non|no|0|false|faux|inactif|inactive)$/.test(v)) return false;
    return null;
  }

  function normalizeDateString(rawVal) {
    const str = String(rawVal == null ? '' : rawVal).trim();
    if (!str) return '';
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
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
    // Normaliser la casse du rôle utilisateur (ex: "technicien" -> "Technicien")
    if (fieldDef.key === 'role_utilisateur' && entry.value) {
      const foundRole = USER_ROLES.find(r => canonicalToken(r) === canonicalToken(entry.value));
      if (foundRole) return foundRole;
    }
    return entry.value;
  }

  function getUserRole(userEntity) {
    const raw = getFieldRawValue(userEntity, { key: 'role_utilisateur', storage: 'aflds' });
    const matched = USER_ROLES.find(r => canonicalToken(r) === canonicalToken(raw));
    return matched || '';
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
      if (opts.length) {
        const matchOpt = opts.find(o => canonicalToken(o) === canonicalToken(str));
        if (!matchOpt) {
          return { valid: false, reason: `Valeur « ${str} » non autorisée. Choisissez parmi : ${opts.join(', ')}.` };
        }
        return { valid: true, normalized: matchOpt };
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
      byToken.set(canonicalToken(d.key), { ...d, targets: [...d.targets] });
    }
    if (Array.isArray(customList)) {
      for (const item of customList) {
        if (!item || !item.key) continue;
        const tok = canonicalToken(item.key);
        if (!tok) continue;
        const existing = byToken.get(tok);
        const mergedTargets = Array.isArray(item.targets) ? [...item.targets] : (existing ? [...existing.targets] : ['unit']);
        if (existing && Array.isArray(existing.targets)) {
          for (const t of existing.targets) {
            if (!mergedTargets.includes(t)) mergedTargets.push(t);
          }
        }
        byToken.set(tok, {
          ...(existing || {}),
          ...item,
          targets: mergedTargets,
          key: existing ? existing.key : normalizeKey(item.key),
          canonicalName: item.canonicalName || (existing && existing.canonicalName) || item.key,
          visibleInMatrix: item.visibleInMatrix !== undefined ? item.visibleInMatrix : true,
          system: existing ? existing.system : false
        });
      }
    }
    return [...byToken.values()];
  }

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
   * Découvre les commandes configurées sur les véhicules Wialon (it.cmds)
   * et fusionne avec le catalogue de commandes de référence.
   */
  function discoverFleetCommands(rawUnits) {
    const map = new Map();
    for (const c of DEFAULT_COMMANDS) {
      map.set(c.key, { ...c, unitCount: 0, wialonNames: new Set() });
    }

    for (const it of rawUnits || []) {
      const cmds = it.cmds ? Object.values(it.cmds) : [];
      for (const cmd of cmds) {
        if (!cmd || !cmd.n) continue;
        const name = String(cmd.n).trim();
        const tok = canonicalToken(name);
        if (!tok) continue;

        // Associer aux commandes standards si le nom correspond
        let matchedKey = null;
        if (/coupure|stop|cut|immobil|arret|bloq/i.test(name)) matchedKey = 'cmd_coupure_moteur';
        else if (/reprise|resume|start|demarr|autoris|debloq/i.test(name)) matchedKey = 'cmd_reprise_moteur';
        else if (/position|locate|ping|coord/i.test(name)) matchedKey = 'cmd_position';
        else if (/reboot|reset|redemarr/i.test(name)) matchedKey = 'cmd_reboot';
        else if (/apn|server|serveur|ota|config|param/i.test(name)) matchedKey = 'cmd_config_ota';

        if (matchedKey && map.has(matchedKey)) {
          const entry = map.get(matchedKey);
          entry.unitCount += 1;
          entry.wialonNames.add(name);
        } else {
          const customKey = 'cmd_' + normalizeKey(name);
          if (!map.has(customKey)) {
            map.set(customKey, {
              key: customKey,
              name,
              category: cmd.c || 'Commande Wialon',
              icon: 'terminal',
              color: '#0284c7',
              description: `Commande détectée sur les véhicules Wialon (${cmd.c || 'standard'})`,
              unitCount: 1,
              wialonNames: new Set([name])
            });
          } else {
            const entry = map.get(customKey);
            entry.unitCount += 1;
            entry.wialonNames.add(name);
          }
        }
      }
    }

    return [...map.values()].map(c => ({
      ...c,
      wialonNames: [...c.wialonNames]
    }));
  }

  /**
   * Charge ou initialise la matrice des droits de commandes par Rôle (Technicien, Support, Client)
   */
  function loadCommandPolicies(primaryResource, commands) {
    const base = defaultRoleCommandPolicies(commands);
    let stored = null;

    if (primaryResource) {
      const entry = findFieldEntry(primaryResource, CMD_POLICY_FIELD_NAME, 'aflds');
      if (entry && entry.value) {
        try { stored = JSON.parse(entry.value); } catch (_e) {}
      }
    }
    if (!stored) {
      try {
        const raw = localStorage.getItem(LOCAL_CMD_POLICY_KEY);
        if (raw) stored = JSON.parse(raw);
      } catch (_e) {}
    }

    if (stored && typeof stored === 'object') {
      for (const role of USER_ROLES) {
        if (!base[role]) base[role] = {};
        const roleStored = stored[role] || {};
        for (const cmd of commands) {
          if (roleStored[cmd.key]) {
            base[role][cmd.key] = {
              view: !!roleStored[cmd.key].view,
              edit: !!roleStored[cmd.key].edit,
              exec: !!roleStored[cmd.key].exec
            };
          }
        }
      }
    }
    return base;
  }

  async function saveCommandPolicies(policies, primaryResource) {
    try {
      localStorage.setItem(LOCAL_CMD_POLICY_KEY, JSON.stringify(policies));
    } catch (_e) {}

    if (primaryResource) {
      const calls = buildFieldUpdateCalls(primaryResource, CMD_POLICY_FIELD_NAME, JSON.stringify(policies), 'aflds');
      if (calls.length) {
        const [res] = await api().batch([{ svc: calls[0].svc, params: calls[0].params }]);
        if (!res || !res.error) applyLocalFieldMutation(calls[0]._meta, res);
      }
    }
    return policies;
  }

  /**
   * Évalue les droits (view, edit, exec) d'un utilisateur sur une commande donnée :
   * - Hérite par défaut du rôle de l'utilisateur (Technicien, Support, Client)
   * - Peut être surchargé individuellement sur la fiche de l'utilisateur (_igeo_user_cmd_acl)
   */
  function getUserCommandOverrides(userEntity) {
    const entry = findFieldEntry(userEntity.raw, USER_CMD_OVERRIDE_FIELD, 'aflds');
    if (entry && entry.value) {
      try {
        const parsed = JSON.parse(entry.value);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_e) {}
    }
    return {};
  }

  function evaluateUserCommandAccess(userEntity, cmdKey, policies) {
    const role = getUserRole(userEntity) || 'Client';
    const rolePolicy = (policies && policies[role] && policies[role][cmdKey]) || { view: false, edit: false, exec: false };
    const overrides = getUserCommandOverrides(userEntity);
    const own = overrides[cmdKey] || null;

    // Si la commande est la coupure moteur et que l'utilisateur a la permission explicite coupure_moteur = oui/non
    if (cmdKey === 'cmd_coupure_moteur' && !own) {
      const coupureEntry = findFieldEntry(userEntity.raw, 'coupure_moteur', 'aflds');
      const coupureBool = coupureEntry ? parseBoolValue(coupureEntry.value) : null;
      if (coupureBool !== null) {
        return {
          role,
          inherited: false,
          view: coupureBool || rolePolicy.view,
          edit: rolePolicy.edit,
          exec: coupureBool
        };
      }
    }

    if (own) {
      return {
        role,
        inherited: false,
        view: own.view !== undefined ? !!own.view : rolePolicy.view,
        edit: own.edit !== undefined ? !!own.edit : rolePolicy.edit,
        exec: own.exec !== undefined ? !!own.exec : rolePolicy.exec
      };
    }

    return {
      role,
      inherited: true,
      view: !!rolePolicy.view,
      edit: !!rolePolicy.edit,
      exec: !!rolePolicy.exec
    };
  }

  /**
   * Enregistre une surcharge de droit de commande (view/edit/exec) sur un utilisateur
   * et met à jour un résumé lisible dans ses champs administratifs Wialon
   */
  async function updateUserCommandOverride(userEntity, cmdKey, nextAccessOrNull, commands, policies) {
    const overrides = { ...getUserCommandOverrides(userEntity) };
    if (nextAccessOrNull === null) {
      delete overrides[cmdKey];
    } else {
      overrides[cmdKey] = {
        view: !!nextAccessOrNull.view,
        edit: !!nextAccessOrNull.edit,
        exec: !!nextAccessOrNull.exec
      };
    }

    const calls = [];
    const overrideStr = Object.keys(overrides).length ? JSON.stringify(overrides) : '';
    calls.push(...buildFieldUpdateCalls(userEntity.raw, USER_CMD_OVERRIDE_FIELD, overrideStr, 'aflds'));

    // Synchroniser aussi le champ coupure_moteur si on modifie cmd_coupure_moteur
    if (cmdKey === 'cmd_coupure_moteur') {
      const coupureVal = nextAccessOrNull === null ? '' : (nextAccessOrNull.exec ? 'oui' : 'non');
      calls.push(...buildFieldUpdateCalls(userEntity.raw, 'coupure_moteur', coupureVal, 'aflds'));
    }

    if (calls.length) {
      const results = await api().batch(calls.map(c => ({ svc: c.svc, params: c.params })));
      results.forEach((r, idx) => {
        if (!r || !r.error) applyLocalFieldMutation(calls[idx]._meta, r);
      });
    }
    return overrides;
  }

  // ── GESTION DES ACCÈS AUX RAPPORTS IGEO (ÉCO-CONDUITE EC04 & CARBURANT V20) ──
  const REQUIRED_REPORT_ACCESS_MASK = 0x20 | 0x1000; // 4128 : Consulter champs personnalisés (0x20) + Consulter champs administratifs (0x1000)

  /**
   * Vérifie si un utilisateur Wialon possède les droits nécessaires (0x20 + 0x1000)
   * pour que les rapports officiels Igeo (Éco-conduite EC04, Carburant V20) affichent ses véhicules.
   */
  async function getUserReportAccess(userId) {
    try {
      const res = await api().call('user/get_items_access', {
        userId: Number(userId),
        directAccess: false,
        itemSuperclass: ''
      });
      if (!res || typeof res !== 'object' || res.error) {
        return { ok: false, missingCount: 0, totalItems: 0, error: (res && res.reason) || 'Erreur API' };
      }
      const entries = Object.entries(res);
      let missingCount = 0;
      for (const [_itemId, mask] of entries) {
        const m = Number(mask);
        if ((m & REQUIRED_REPORT_ACCESS_MASK) !== REQUIRED_REPORT_ACCESS_MASK) {
          missingCount++;
        }
      }
      return {
        ok: entries.length > 0 && missingCount === 0,
        missingCount,
        totalItems: entries.length
      };
    } catch (e) {
      return { ok: false, missingCount: 0, totalItems: 0, error: e.message };
    }
  }

  /**
   * Débloque en 1 clic l'accès aux rapports Igeo pour un utilisateur Wialon.
   * Ajoute 0x20 (champs personnalisés) et 0x1000 (champs administratifs) sur tous ses véhicules et groupes.
   */
  async function unlockUserReportAccess(userId) {
    const numUserId = Number(userId);
    const accessMap = await api().call('user/get_items_access', {
      userId: numUserId,
      directAccess: false,
      itemSuperclass: ''
    });

    if (!accessMap || typeof accessMap !== 'object' || accessMap.error) {
      throw new Error(`Impossible de récupérer les accès de l'utilisateur #${userId}`);
    }

    const calls = [];
    const entries = Object.entries(accessMap);

    for (const [itemIdStr, currentMask] of entries) {
      const itemId = Number(itemIdStr);
      const m = Number(currentMask);
      if ((m & REQUIRED_REPORT_ACCESS_MASK) !== REQUIRED_REPORT_ACCESS_MASK) {
        const nextMask = m | REQUIRED_REPORT_ACCESS_MASK;
        calls.push({
          svc: 'user/update_item_access',
          params: { userId: numUserId, itemId, accessMask: nextMask }
        });
      }
    }

    if (calls.length > 0) {
      const results = await api().batchChunked(calls);
      const failed = (results || []).filter(r => r && r.error);
      if (failed.length > 0 && failed.length === calls.length) {
        throw new Error(`Échec de la mise à jour des accès Wialon (${failed[0].reason || 'Erreur Wialon'})`);
      }
    }

    return { ok: true, updatedCount: calls.length, totalItems: entries.length };
  }

  /**
   * Débloque l'accès aux rapports pour toute une liste d'utilisateurs
   */
  async function unlockAllUsersReportAccess(users) {
    const list = Array.isArray(users) ? users : [];
    let updatedUsers = 0;
    let totalItemsUpdated = 0;
    const errors = [];

    for (const u of list) {
      try {
        const res = await unlockUserReportAccess(u.id);
        if (res.updatedCount > 0) {
          updatedUsers++;
          totalItemsUpdated += res.updatedCount;
        }
      } catch (err) {
        errors.push(`${u.name || u.id}: ${err.message}`);
      }
    }

    return {
      totalUsers: list.length,
      updatedUsers,
      totalItemsUpdated,
      errors
    };
  }


  /**
   * Scanne en O(N) tous les champs aflds et flds déjà présents sur Véhicules, Groupes, Utilisateurs ET Comptes/Ressources CMS
   */
  function discoverExistingFieldsAndStats(schema, units, groups, users, resources) {
    const byToken = new Map();
    for (const f of schema) {
      const tok = canonicalToken(f.key);
      byToken.set(tok, {
        ...f,
        targets: Array.isArray(f.targets) ? [...f.targets] : ['unit'],
        discoveredNames: new Set([f.canonicalName || f.key]),
        discoveredValues: new Set(Array.isArray(f.options) ? f.options : []),
        filledCount: 0,
        duplicateUnitsCount: 0
      });
      for (const al of getCanonicalAliases(f.key)) {
        if (!byToken.has(al)) byToken.set(al, byToken.get(tok));
      }
    }

    const scanEntities = (entities, entityType) => {
      for (const ent of entities || []) {
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
              const cleanKey = normalizeKey(rawName) || tok;
              fieldMeta = {
                key: cleanKey,
                canonicalName: rawName,
                label: rawName.charAt(0).toUpperCase() + rawName.slice(1).replace(/_/g, ' '),
                description: `Champ existant détecté dans Wialon (${dictName === 'aflds' ? 'Administratif' : 'Personnalisé'})`,
                type: 'text',
                targets: [entityType],
                required: false,
                visibleInMatrix: false,
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
    scanEntities(resources, 'resource');

    const uniqueFields = [];
    const seenFinal = new Set();
    for (const meta of byToken.values()) {
      if (seenFinal.has(meta.key)) continue;
      seenFinal.add(meta.key);

      const valuesArr = [...meta.discoveredValues].sort((a, b) => a.localeCompare(b, 'fr'));
      const namesArr = [...meta.discoveredNames];

      if (meta.autoDiscovered) {
        meta.type = inferFieldTypeFromValues(meta.key, valuesArr);
        if (meta.type === 'boolean') {
          meta.category = 'permission';
          meta.icon = 'toggle_on';
        } else if (meta.type === 'date') {
          meta.icon = 'event';
        }
      }

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

  let lastLoadedState = {
    units: [],
    unitsById: new Map(),
    groups: [],
    groupsById: new Map()
  };

  function loadCachedHwTypes() {
    try {
      const raw = localStorage.getItem(LOCAL_HW_TYPES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (_e) {}
    return [];
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

    const cachedHwTypes = loadCachedHwTypes();

    const batchRes = await api().batch([
      search('avl_unit', UNIT_FLAGS),
      search('avl_unit_group', GROUP_FLAGS),
      search('user', USER_FLAGS),
      search('avl_resource', RES_FLAGS)
    ]);

    const [unitsRes, groupsRes, usersRes, resRes] = batchRes || [];
    if (!unitsRes || unitsRes.error) {
      throw new api().IgeoError(unitsRes ? unitsRes.error : 5, 'core/search_items', 'Impossible de charger les véhicules');
    }

    const hwById = new Map();
    for (const hw of cachedHwTypes) {
      if (hw && hw.id) hwById.set(Number(hw.id), hw);
    }

    const rawResources = (resRes && resRes.items) || [];
    rawResources.sort((a, b) => {
      const aPri = /3dt|3dtech|igeo/i.test(a.nm || '') ? 1 : 0;
      const bPri = /3dt|3dtech|igeo/i.test(b.nm || '') ? 1 : 0;
      return bPri - aPri;
    });

    // Transformation des Comptes & Ressources CMS en entités éditables
    const resources = rawResources.map(r => {
      const raw = {
        id: r.id,
        nm: r.nm,
        bact: r.bact,
        aflds: r.aflds ? { ...r.aflds } : {},
        flds: r.flds ? { ...r.flds } : {}
      };
      ensureRawItemIndex(raw);
      return {
        id: Number(r.id),
        entityType: 'resource',
        name: r.nm || `Ressource #${r.id}`,
        accountId: r.bact || r.id,
        creatorId: r.crt || 0,
        raw
      };
    });
    const primaryResource = resources[0] ? resources[0].raw : null;

    let baseSchema = loadCachedSchema();
    if (primaryResource) {
      const schemaEntry = findFieldEntry(primaryResource, SCHEMA_FIELD_NAME, 'aflds');
      if (schemaEntry && schemaEntry.value) {
        try {
          baseSchema = mergeSchemaWithDefaults(JSON.parse(schemaEntry.value));
        } catch (_e) {}
      }
    }

    const groups = ((groupsRes && groupsRes.items) || []).map(g => {
      const raw = {
        id: g.id,
        nm: g.nm,
        aflds: g.aflds ? { ...g.aflds } : {},
        flds: g.flds ? { ...g.flds } : {}
      };
      ensureRawItemIndex(raw);
      return {
        id: Number(g.id),
        entityType: 'group',
        name: g.nm || `Groupe #${g.id}`,
        unitIds: Array.isArray(g.u) ? g.u.map(Number) : [],
        raw
      };
    });

    const groupsById = new Map(groups.map(g => [g.id, g]));
    const groupIdsByUnitId = new Map();
    for (const g of groups) {
      for (const uId of g.unitIds) {
        const numId = Number(uId);
        if (!groupIdsByUnitId.has(numId)) groupIdsByUnitId.set(numId, []);
        groupIdsByUnitId.get(numId).push(g.id);
      }
    }

    const rawUnits = (unitsRes && unitsRes.items) || [];
    const units = rawUnits.map(it => {
      const numId = Number(it.id);
      const gIds = groupIdsByUnitId.get(numId) || [];
      const hwId = it.hw ? Number(it.hw) : 0;
      const hwObj = hwById.get(hwId);
      const unitCmds = it.cmds ? Object.values(it.cmds).map(c => c && c.n).filter(Boolean) : [];
      const raw = {
        id: it.id,
        nm: it.nm,
        aflds: it.aflds ? { ...it.aflds } : {},
        flds: it.flds ? { ...it.flds } : {}
      };
      ensureRawItemIndex(raw);
      return {
        id: numId,
        entityType: 'unit',
        name: it.nm || `Unité #${it.id}`,
        imei: it.uid ? String(it.uid) : '',
        imei2: it.uid2 ? String(it.uid2) : '',
        phone: it.ph ? String(it.ph) : '',
        hwId,
        hwName: hwObj ? hwObj.name : (hwId ? `Boîtier #${hwId}` : 'Non défini'),
        groupIds: gIds,
        groupNames: gIds.map(id => (groupsById.get(id) ? groupsById.get(id).name : '')).filter(Boolean),
        commands: unitCmds,
        raw
      };
    });

    const unitsById = new Map(units.map(u => [u.id, u]));
    lastLoadedState = { units, unitsById, groups, groupsById, primaryResource };

    // Nettoyage automatique en arrière-plan des champs techniques _igeo_photo_journal présents sur les véhicules (pour garder l'infobulle Wialon propre)
    if (primaryResource) {
      const cleanupCalls = [];
      for (const u of units) {
        const legacy = findFieldEntry(u.raw, PHOTO_JOURNAL_FIELD, 'aflds');
        if (legacy && legacy.value) {
          const resKey = `_igeo_uj_${u.id}`;
          if (!findFieldEntry(primaryResource, resKey, 'aflds')) {
            cleanupCalls.push(...buildChunkedFieldWriteCalls(primaryResource, resKey, legacy.value, 'aflds'));
          }
          cleanupCalls.push(...buildChunkedFieldWriteCalls(u.raw, PHOTO_JOURNAL_FIELD, '', 'aflds'));
        }
      }
      if (cleanupCalls.length) {
        api().batchChunked(cleanupCalls.map(c => ({ svc: c.svc, params: c.params }))).then(resList => {
          resList.forEach((r, idx) => {
            if (!r || !r.error) applyLocalFieldMutation(cleanupCalls[idx]._meta, r);
          });
        }).catch(() => {});
      }
    }

    const users = ((usersRes && usersRes.items) || []).map(u => {
      const raw = {
        id: u.id,
        nm: u.nm,
        aflds: u.aflds ? { ...u.aflds } : {},
        flds: u.flds ? { ...u.flds } : {}
      };
      ensureRawItemIndex(raw);
      return {
        id: Number(u.id),
        entityType: 'user',
        name: u.nm || `Utilisateur #${u.id}`,
        accountId: u.bact || 0,
        raw
      };
    });

    // Découverte des commandes des véhicules et chargement des politiques par Rôle (Technicien, Support, Client)
    const commands = discoverFleetCommands(rawUnits);
    const commandPolicies = loadCommandPolicies(primaryResource, commands);

    // Auto-découverte O(N) de tous les champs existants sur Véhicules, Groupes, Utilisateurs et Comptes/Ressources CMS
    const schema = discoverExistingFieldsAndStats(baseSchema, units, groups, users, resources);
    saveCachedSchema(schema);

    // En arrière-plan (sans bloquer l'affichage) :
    // 1. Charger les modèles de boîtiers si le cache était vide
    if (!cachedHwTypes.length) {
      api().call('core/get_hw_types', { filterType: 'name' }).then(list => {
        if (!Array.isArray(list) || !list.length) return;
        const compact = list.filter(h => h && h.id).map(h => ({ id: Number(h.id), name: h.name }));
        try { localStorage.setItem(LOCAL_HW_TYPES_KEY, JSON.stringify(compact)); } catch (_e) {}
        for (const hw of compact) hwById.set(hw.id, hw);
        for (const u of units) {
          const found = hwById.get(u.hwId);
          if (found) u.hwName = found.name;
        }
      }).catch(() => {});
    }

    // 2. Synchroniser silencieusement les permissions déjà présentes dans aflds vers flds, les unités membres des groupes (ex: MR DONALD) et les droits d'accès aux rapports pour les utilisateurs
    syncExistingPermissionsInBackground(units, groups, groupsById, users).catch(() => {});

    return {
      units,
      groups,
      groupsById,
      users,
      resources,
      primaryResource,
      hwTypes: cachedHwTypes,
      hwById,
      commands,
      commandPolicies,
      schema
    };
  }

  function buildSingleDictFieldCalls(rawItem, fieldKey, preferredName, strVal, dictName) {
    const idx = ensureRawItemIndex(rawItem);
    const targetTokens = getCanonicalAliases(fieldKey);
    const map = idx[dictName];
    const matches = [];
    for (const tok of targetTokens) {
      const list = map.get(tok);
      if (list && list.length) {
        for (let i = 0; i < list.length; i++) matches.push(list[i]);
      }
    }

    const svc = dictName === 'flds' ? 'item/update_custom_field' : 'item/update_admin_field';
    const calls = [];

    if (!strVal) {
      for (const m of matches) {
        calls.push({
          svc,
          params: { itemId: rawItem.id, id: m.id, callMode: 'delete' },
          _meta: { rawItem, fieldKey, strVal: '', storage: dictName, mode: 'delete', oldId: m.id }
        });
      }
      return calls;
    }

    if (matches.length > 0) {
      const primary = matches[0];
      if (primary.value !== strVal || primary.name !== preferredName) {
        calls.push({
          svc,
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
            storage: dictName,
            mode: 'update',
            oldId: primary.id
          }
        });
      }
      for (let i = 1; i < matches.length; i++) {
        const dup = matches[i];
        calls.push({
          svc,
          params: { itemId: rawItem.id, id: dup.id, callMode: 'delete' },
          _meta: { rawItem, fieldKey: dup.name, strVal: '', storage: dictName, mode: 'delete', oldId: dup.id }
        });
      }
      return calls;
    }

    calls.push({
      svc,
      params: {
        itemId: rawItem.id,
        id: 0,
        callMode: 'create',
        n: preferredName,
        v: strVal
      },
      _meta: { rawItem, fieldKey: preferredName, strVal, storage: dictName, mode: 'create' }
    });
    return calls;
  }

  function buildFieldUpdateCalls(rawItem, fieldDefOrKey, newValue, storage = 'aflds') {
    const fieldKey = typeof fieldDefOrKey === 'object' ? fieldDefOrKey.key : fieldDefOrKey;
    const preferredName = (typeof fieldDefOrKey === 'object' && fieldDefOrKey.canonicalName)
      ? fieldDefOrKey.canonicalName
      : fieldKey;
    const targetStorage = (typeof fieldDefOrKey === 'object' && fieldDefOrKey.storage)
      ? fieldDefOrKey.storage
      : storage;
    const strVal = newValue == null ? '' : String(newValue).trim();

    // Si c'est une permission booléenne (ecodrive, carburant, coupure_moteur, rapport_journalier),
    // on écrit simultanément dans aflds ET flds pour que rapports.igeopilot.com le voie immédiatement !
    const isMirroredPerm = MIRRORED_PERMISSION_KEYS.has(canonicalToken(fieldKey))
      || (typeof fieldDefOrKey === 'object' && fieldDefOrKey.type === 'boolean');

    if (isMirroredPerm) {
      return [
        ...buildSingleDictFieldCalls(rawItem, fieldKey, preferredName, strVal, 'aflds'),
        ...buildSingleDictFieldCalls(rawItem, fieldKey, preferredName, strVal, 'flds')
      ];
    }

    const allMatches = findAllMatchingEntries(rawItem, fieldKey, targetStorage);
    const calls = [];

    if (!strVal) {
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

  // Construit les appels de propagation d'une permission de groupe (_igeo_grp_ecodrive / _igeo_grp_carburant) vers ses véhicules membres
  function buildGroupMemberMirrorCalls(groupEntity, permKey, nextGroupBoolVal) {
    const tok = canonicalToken(permKey);
    if (tok !== 'ecodrive' && tok !== 'carburant') return [];
    const helperFieldName = tok === 'ecodrive' ? '_igeo_grp_ecodrive' : '_igeo_grp_carburant';
    const calls = [];

    for (const uId of groupEntity.unitIds || []) {
      const unit = lastLoadedState.unitsById.get(Number(uId));
      if (!unit) continue;

      // Vérifier si l'unité appartient à au moins un groupe ayant cette permission active
      let anyGroupActive = nextGroupBoolVal === true;
      if (!anyGroupActive) {
        for (const otherGId of unit.groupIds || []) {
          if (Number(otherGId) === Number(groupEntity.id)) continue;
          const otherG = lastLoadedState.groupsById.get(Number(otherGId));
          if (otherG && parseBoolValue(getFieldRawValue(otherG, { key: tok, storage: 'aflds' })) === true) {
            anyGroupActive = true;
            break;
          }
        }
      }

      const desiredHelperVal = anyGroupActive ? 'oui' : '';
      calls.push(...buildSingleDictFieldCalls(unit.raw, helperFieldName, helperFieldName, desiredHelperVal, 'flds'));
    }
    return calls;
  }

  // Synchronise automatiquement en tâche de fond toute permission aflds (ex: MR DONALD) qui ne serait pas encore copiée dans flds (et vice-versa pour les seuils planchers)
  async function syncExistingPermissionsInBackground(units, groups, groupsById, users) {
    const calls = [];
    for (const g of groups) {
      for (const pKey of ['ecodrive', 'carburant', 'fuel_sensor_floor']) {
        const afEntry = findFieldEntry(g.raw, pKey, 'aflds');
        const fldEntry = findFieldEntry(g.raw, pKey, 'flds');
        if (afEntry && afEntry.value && (!fldEntry || fldEntry.value !== afEntry.value)) {
          calls.push(...buildSingleDictFieldCalls(g.raw, pKey, pKey, afEntry.value, 'flds'));
        } else if (fldEntry && fldEntry.value && (!afEntry || afEntry.value !== fldEntry.value)) {
          calls.push(...buildSingleDictFieldCalls(g.raw, pKey, pKey, fldEntry.value, 'aflds'));
        }
      }
    }
    for (const u of units) {
      for (const pKey of ['ecodrive', 'carburant', 'fuel_sensor_floor']) {
        const afEntry = findFieldEntry(u.raw, pKey, 'aflds');
        const fldEntry = findFieldEntry(u.raw, pKey, 'flds');
        if (afEntry && afEntry.value && (!fldEntry || fldEntry.value !== afEntry.value)) {
          calls.push(...buildSingleDictFieldCalls(u.raw, pKey, pKey, afEntry.value, 'flds'));
        } else if (fldEntry && fldEntry.value && (!afEntry || afEntry.value !== fldEntry.value)) {
          calls.push(...buildSingleDictFieldCalls(u.raw, pKey, pKey, fldEntry.value, 'aflds'));
        }
        // Synchroniser le tag hérité de groupe (_igeo_grp_ecodrive / _igeo_grp_carburant) sur l'unité
        if (pKey === 'ecodrive' || pKey === 'carburant') {
          const helperName = pKey === 'ecodrive' ? '_igeo_grp_ecodrive' : '_igeo_grp_carburant';
          const inheritedActive = (u.groupIds || []).some(gId => {
            const grp = groupsById.get(Number(gId));
            return grp && parseBoolValue(getFieldRawValue(grp, { key: pKey, storage: 'aflds' })) === true;
          });
          const desiredVal = inheritedActive ? 'oui' : '';
          calls.push(...buildSingleDictFieldCalls(u.raw, helperName, helperName, desiredVal, 'flds'));
        }
      }
    }
    if (calls.length) {
      const resList = await api().batchChunked(calls.map(c => ({ svc: c.svc, params: c.params })));
      resList.forEach((r, idx) => {
        if (!r || !r.error) applyLocalFieldMutation(calls[idx]._meta, r);
      });
    }

    // Auto-réparation silencieuse en arrière-plan des droits d'accès aux rapports pour les utilisateurs
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        try {
          const accessMap = await api().call('user/get_items_access', {
            userId: Number(u.id),
            directAccess: false,
            itemSuperclass: ''
          });
          if (accessMap && typeof accessMap === 'object' && !accessMap.error) {
            const userCalls = [];
            for (const [itemIdStr, currentMask] of Object.entries(accessMap)) {
              const m = Number(currentMask);
              if ((m & REQUIRED_REPORT_ACCESS_MASK) !== REQUIRED_REPORT_ACCESS_MASK) {
                userCalls.push({
                  svc: 'user/update_item_access',
                  params: { userId: Number(u.id), itemId: Number(itemIdStr), accessMask: m | REQUIRED_REPORT_ACCESS_MASK }
                });
              }
            }
            if (userCalls.length > 0) {
              await api().batchChunked(userCalls);
            }
          }
        } catch (_uErr) {}
      }
    }
  }

  function applyLocalFieldMutation(meta, resItem) {
    const dictKey = meta.storage === 'flds' ? 'flds' : 'aflds';
    if (!meta.rawItem[dictKey]) meta.rawItem[dictKey] = {};
    const dict = meta.rawItem[dictKey];
    delete meta.rawItem._idx;

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
      const entCalls = buildFieldUpdateCalls(ent.raw, fieldDef, strVal, fieldDef.storage || 'aflds');
      if (prevVal === strVal && !entCalls.length) continue;
      previousSnapshot.push({ entity: ent, previousValue: prevVal });
      callsWithMeta.push(...entCalls);

      if (ent.entityType === 'group') {
        const groupMirrorCalls = buildGroupMemberMirrorCalls(ent, fieldDef.key, parseBoolValue(strVal));
        callsWithMeta.push(...groupMirrorCalls);
      }
    }

    if (!callsWithMeta.length) return { updated: 0 };

    const batchPayload = callsWithMeta.map(c => ({ svc: c.svc, params: c.params }));
    const results = await api().batchChunked(batchPayload);

    const entityOutcome = new Map();
    results.forEach((res, idx) => {
      const meta = callsWithMeta[idx]._meta;
      const itemId = (meta.rawItem && meta.rawItem.id) || idx;
      if (!entityOutcome.has(itemId)) {
        entityOutcome.set(itemId, {
          name: (meta.rawItem && (meta.rawItem.nm || meta.rawItem.name)) || String(itemId),
          successes: 0,
          errors: []
        });
      }
      const outcome = entityOutcome.get(itemId);
      if (res && res.error) {
        outcome.errors.push(`Erreur Wialon (${res.error}) sur ${outcome.name} [${meta.storage}]`);
      } else {
        outcome.successes += 1;
        applyLocalFieldMutation(meta, res);
      }
    });

    const fatalErrors = [];
    for (const [, outcome] of entityOutcome.entries()) {
      if (outcome.successes === 0 && outcome.errors.length > 0) {
        fatalErrors.push(...outcome.errors);
      }
    }

    if (fatalErrors.length) {
      throw new Error(fatalErrors.slice(0, 3).join(' · '));
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
      if (item.entity.entityType === 'group') {
        callsWithMeta.push(...buildGroupMemberMirrorCalls(item.entity, last.fieldDef.key, parseBoolValue(item.previousValue)));
      }
    }

    if (callsWithMeta.length) {
      const results = await api().batchChunked(callsWithMeta.map(c => ({ svc: c.svc, params: c.params })));
      results.forEach((res, idx) => {
        if (!res || !res.error) applyLocalFieldMutation(callsWithMeta[idx]._meta, res);
      });
    }
    return last;
  }

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

  async function saveSchema(schema, primaryResource, units = [], groups = [], users = [], resources = []) {
    const merged = discoverExistingFieldsAndStats(mergeSchemaWithDefaults(schema), units, groups, users, resources);
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

  // ── JOURNAL DE L'UNITÉ & PHOTOS D'INTERVENTION (Edge /photo + file/write + unit/upload_image + unit/registry_custom_event + aflds chunked) ──
  const PHOTO_JOURNAL_FIELD = '_igeo_photo_journal';
  const PHOTO_LOCAL_CACHE_KEY = 'igeo_admin_photo_cache_v1';
  const AFLDS_CHUNK_SIZE = 420;
  const JOURNAL_CATEGORIES = [
    'Installation',
    'Swap boîtier',
    'Maintenance',
    'Contrôle / État',
    'Autre'
  ];

  const photoMemoryCache = new Map();

  function loadLocalPhotoCache() {
    try {
      const raw = localStorage.getItem(PHOTO_LOCAL_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_e) {}
    return {};
  }

  function cachePhotoLocally(entryId, dataUrl) {
    if (!entryId || !dataUrl) return;
    photoMemoryCache.set(entryId, dataUrl);
    try {
      const cache = loadLocalPhotoCache();
      cache[entryId] = { dataUrl, t: Date.now() };
      const keys = Object.keys(cache).sort((a, b) => (cache[b].t || 0) - (cache[a].t || 0));
      const trimmed = {};
      for (const k of keys.slice(0, 12)) {
        trimmed[k] = cache[k];
      }
      localStorage.setItem(PHOTO_LOCAL_CACHE_KEY, JSON.stringify(trimmed));
    } catch (_e) {}
  }

  function getCachedPhotoDataUrl(entryId) {
    if (!entryId) return '';
    if (photoMemoryCache.has(entryId)) return photoMemoryCache.get(entryId);
    const local = loadLocalPhotoCache();
    if (local[entryId] && local[entryId].dataUrl) {
      photoMemoryCache.set(entryId, local[entryId].dataUrl);
      return local[entryId].dataUrl;
    }
    return '';
  }

  function buildChunkedFieldWriteCalls(rawItem, baseKey, fullString, dictName = 'aflds') {
    const str = String(fullString || '');
    const chunks = [];
    if (str.length > 0) {
      for (let offset = 0; offset < str.length; offset += AFLDS_CHUNK_SIZE) {
        chunks.push(str.slice(offset, offset + AFLDS_CHUNK_SIZE));
      }
    }

    const calls = [];
    // Écrire ou supprimer le segment principal (index 0)
    calls.push(...buildSingleDictFieldCalls(rawItem, baseKey, baseKey, chunks[0] || '', dictName));

    // Écrire les segments suivants __1, __2, ...
    for (let idx = 1; idx < chunks.length; idx++) {
      const chunkKey = `${baseKey}__${idx}`;
      calls.push(...buildSingleDictFieldCalls(rawItem, chunkKey, chunkKey, chunks[idx], dictName));
    }

    // Supprimer les anciens segments excédentaires éventuels
    const dict = (rawItem && rawItem[dictName]) || {};
    const prefix = `${baseKey.toLowerCase()}__`;
    for (const entry of Object.values(dict)) {
      if (!entry || !entry.n) continue;
      const lowerName = String(entry.n).trim().toLowerCase();
      if (lowerName.startsWith(prefix)) {
        const suffixNum = Number(lowerName.slice(prefix.length));
        if (Number.isFinite(suffixNum) && suffixNum >= Math.max(1, chunks.length)) {
          calls.push(...buildSingleDictFieldCalls(rawItem, entry.n, entry.n, '', dictName));
        }
      }
    }

    return calls;
  }

  function readChunkedField(rawItem, baseKey, dictName = 'aflds') {
    if (!rawItem) return '';
    const first = findFieldEntry(rawItem, baseKey, dictName);
    if (!first || !first.value) return '';
    let out = String(first.value);
    for (let idx = 1; idx <= 60; idx++) {
      const next = findFieldEntry(rawItem, `${baseKey}__${idx}`, dictName);
      if (!next || !next.value) break;
      out += String(next.value);
    }
    return out;
  }

  function compressImageFile(file, maxDim = 1100, quality = 0.78) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('Le fichier sélectionné n’est pas une image valide.'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Impossible de lire le fichier image.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Format d’image non supporté.'));
        img.onload = () => {
          const renderScaled = (targetMax, q, mime = 'image/webp') => {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > targetMax || h > targetMax) {
              if (w >= h) {
                h = Math.round((h * targetMax) / w);
                w = targetMax;
              } else {
                w = Math.round((w * targetMax) / h);
                h = targetMax;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, w);
            canvas.height = Math.max(1, h);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            let dataUrl = canvas.toDataURL(mime, q);
            if (mime === 'image/webp' && (!dataUrl || !dataUrl.startsWith('data:image/webp'))) {
              dataUrl = canvas.toDataURL('image/jpeg', q);
            }
            return { dataUrl, width: canvas.width, height: canvas.height };
          };

          const full = renderScaled(maxDim, quality, 'image/webp');
          const jpegForWialon = renderScaled(640, 0.80, 'image/jpeg');
          // Miniature ultra-légère pour stockage segmenté dans aflds (420 chars / segment)
          let micro = renderScaled(220, 0.48, 'image/webp');
          if (micro.dataUrl.length > 3600) {
            micro = renderScaled(160, 0.42, 'image/webp');
          }

          resolve({
            fullDataUrl: full.dataUrl,
            jpegDataUrl: jpegForWialon.dataUrl,
            microDataUrl: micro.dataUrl,
            width: full.width,
            height: full.height,
            sizeKb: Math.round((full.dataUrl.length * 0.75) / 1024)
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function getPhotoPublicUrl(unitId, entryId) {
    const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
      ? window.location.origin
      : 'https://admin.igeopilot.com';
    return `${origin}/photo/${unitId}/${entryId}`;
  }

  function getUnitPhotoJournalIndex(unit) {
    if (!unit || !unit.raw) return [];
    const rawJson = readChunkedField(unit.raw, PHOTO_JOURNAL_FIELD, 'aflds');
    let list = [];
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed)) list = parsed;
      } catch (_e) {}
    }
    return list.map(item => {
      const cached = getCachedPhotoDataUrl(item.id);
      const afldsDataUrl = readChunkedField(unit.raw, `_igeo_ph_${item.id}`, 'aflds');
      const publicUrl = item.publicUrl || (item.id && String(item.id).startsWith('ph_') ? getPhotoPublicUrl(unit.id, item.id) : '');
      return {
        ...item,
        publicUrl,
        dataUrl: cached || afldsDataUrl || item.dataUrl || ''
      };
    });
  }

  async function addUnitJournalPhoto({
    unit,
    primaryResource,
    files = [],
    category = 'Installation',
    comment = '',
    eventDate = '',
    userName = '',
    setAsUnitImage = true
  }) {
    if (!unit || !unit.raw) throw new Error('Véhicule introuvable.');
    const fileList = Array.from(files || []).filter(Boolean);
    const cleanComment = String(comment || '').trim();
    if (!fileList.length && !cleanComment) {
      throw new Error('Veuillez sélectionner au moins une photo ou saisir un commentaire pour le journal.');
    }

    const effectiveDate = eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
      ? eventDate
      : new Date().toISOString().slice(0, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    const author = userName || 'Admin';

    const currentIndex = getUnitPhotoJournalIndex(unit).map(it => {
      const copy = { ...it };
      delete copy.dataUrl;
      return copy;
    });

    const newEntries = [];
    const adminCalls = [];

    if (fileList.length > 0) {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const compressed = await compressImageFile(file);
        const entryId = `ph_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`;
        const filePath = `/igeo_${entryId}.json`;
        const publicUrl = getPhotoPublicUrl(unit.id, entryId);

        // Cache mémoire + localStorage immédiat pour affichage instantané 0ms
        cachePhotoLocally(entryId, compressed.fullDataUrl);

        const metaItem = {
          id: entryId,
          date: effectiveDate,
          timestamp: nowSec + i,
          category: category || 'Installation',
          comment: cleanComment || file.name,
          author,
          fileName: file.name || `${entryId}.webp`,
          width: compressed.width,
          height: compressed.height,
          sizeKb: compressed.sizeKb,
          filePath,
          publicUrl,
          storageItemId: unit.id,
          loggedInWialonEvents: false
        };

        // 0. Publication sur le cache Edge de admin.igeopilot.com (/photo/:unitId/:entryId)
        try {
          await fetch(`/photo/${encodeURIComponent(unit.id)}/${encodeURIComponent(entryId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dataUrl: compressed.fullDataUrl,
              unitId: unit.id,
              unitName: unit.name,
              comment: metaItem.comment,
              category: metaItem.category,
              date: metaItem.date,
              author
            })
          });
        } catch (_edgeErr) {}

        // 1. Téléversement comme image officielle de l'unité dans Wialon (unit/upload_image)
        // Permet de voir l'aperçu directement dans l'infobulle et les propriétés de l'unité sur Wialon !
        if (setAsUnitImage && i === 0) {
          try {
            await api().call('unit/upload_image', {
              itemId: unit.id,
              dataUrl: compressed.jpegDataUrl
            });
            metaItem.uploadedToUnitProfile = true;
          } catch (_upErr) {}
        }

        // 2. Écriture de la photo haute définition à la racine du File Storage Wialon (file/write)
        const filePayload = JSON.stringify({
          ...metaItem,
          unitId: unit.id,
          unitName: unit.name,
          dataUrl: compressed.fullDataUrl
        });

        try {
          const fwRes = await api().call('file/write', {
            itemId: unit.id,
            storageType: 1,
            path: filePath,
            content: filePayload,
            writeType: 0,
            contentType: 0
          });
          if (fwRes && fwRes.error) throw new Error('unit file/write error ' + fwRes.error);
          metaItem.fileStorageOk = true;
        } catch (_fwErr) {
          if (primaryResource && primaryResource.id) {
            try {
              const resPath = `/igeo_u${unit.id}_${entryId}.json`;
              const fwRes2 = await api().call('file/write', {
                itemId: primaryResource.id,
                storageType: 1,
                path: resPath,
                content: filePayload,
                writeType: 0,
                contentType: 0
              });
              if (!fwRes2 || !fwRes2.error) {
                metaItem.filePath = resPath;
                metaItem.storageItemId = primaryResource.id;
                metaItem.fileStorageOk = true;
              }
            } catch (_e2) {}
          }
        }

        // 3. Enregistrement dans le Journal d'événements de l'unité Wialon (unit/registry_custom_event) avec lien direct
        try {
          const evDesc = `[PHOTO IGEO · ${metaItem.category}] ${metaItem.comment} (par ${author}) — Aperçu : ${publicUrl}`;
          const evRes = await api().call('unit/registry_custom_event', {
            itemId: unit.id,
            date: metaItem.timestamp,
            x: 0,
            y: 0,
            violation: 0,
            description: evDesc
          });
          if (!evRes || !evRes.error) {
            metaItem.loggedInWialonEvents = true;
          }
        } catch (_evErr) {}

        // 4. Sauvegarde segmentée (<= 420 chars par champ) de la miniature WebP dans aflds pour garantie 100%
        adminCalls.push(...buildChunkedFieldWriteCalls(unit.raw, `_igeo_ph_${entryId}`, compressed.microDataUrl, 'aflds'));
        // Et mise à jour du champ personnalisé visible dans l'infobulle Wialon
        if (i === 0) {
          adminCalls.push(...buildSingleDictFieldCalls(unit.raw, 'derniere_photo_igeo', 'Dernière photo Igeo', publicUrl, 'flds'));
        }

        currentIndex.unshift(metaItem);
        newEntries.push({ ...metaItem, dataUrl: compressed.fullDataUrl });
      }
    } else {
      // Entrée texte seule dans le journal de l'unité
      const entryId = `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const metaItem = {
        id: entryId,
        date: effectiveDate,
        timestamp: nowSec,
        category: category || 'Maintenance',
        comment: cleanComment,
        author,
        fileName: '',
        loggedInWialonEvents: false
      };
      try {
        const evDesc = `[JOURNAL IGEO · ${metaItem.category}] ${metaItem.comment} (par ${author})`;
        const evRes = await api().call('unit/registry_custom_event', {
          itemId: unit.id,
          date: metaItem.timestamp,
          x: 0,
          y: 0,
          violation: 0,
          description: evDesc
        });
        if (!evRes || !evRes.error) metaItem.loggedInWialonEvents = true;
      } catch (_evErr) {}
      currentIndex.unshift(metaItem);
      newEntries.push(metaItem);
    }

    // Limiter l'index aux 20 dernières entrées pour préserver la légèreté
    const trimmedIndex = currentIndex.slice(0, 20);
    const removedEntries = currentIndex.slice(20);
    for (const rem of removedEntries) {
      adminCalls.push(...buildChunkedFieldWriteCalls(unit.raw, `_igeo_ph_${rem.id}`, '', 'aflds'));
    }

    adminCalls.push(...buildChunkedFieldWriteCalls(unit.raw, PHOTO_JOURNAL_FIELD, JSON.stringify(trimmedIndex), 'aflds'));

    if (adminCalls.length) {
      const resList = await api().batchChunked(adminCalls.map(c => ({ svc: c.svc, params: c.params })));
      resList.forEach((r, idx) => {
        if (!r || !r.error) applyLocalFieldMutation(adminCalls[idx]._meta, r);
      });
    }

    return newEntries;
  }

  async function loadUnitJournalDetails(unit, primaryResource) {
    const entries = getUnitPhotoJournalIndex(unit);

    // 1. Tenter de récupérer la version haute définition depuis file/read pour les entrées ayant un filePath
    await Promise.all(entries.map(async (entry) => {
      if (!entry.filePath) return;
      const targetItemId = entry.storageItemId || unit.id;
      try {
        const res = await api().call('file/read', {
          itemId: targetItemId,
          storageType: 1,
          path: entry.filePath
        });
        if (res && !res.error) {
          const rawStr = typeof res === 'string' ? res : (res.content || res.text || '');
          if (rawStr) {
            const parsed = JSON.parse(rawStr);
            if (parsed && parsed.dataUrl) {
              entry.dataUrl = parsed.dataUrl;
              cachePhotoLocally(entry.id, parsed.dataUrl);
              // Re-peupler le cache Edge /photo/:unitId/:entryId en arrière-plan
              fetch(`/photo/${encodeURIComponent(unit.id)}/${encodeURIComponent(entry.id)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dataUrl: parsed.dataUrl, unitId: unit.id })
              }).catch(() => {});
            }
          }
        }
      } catch (_e) {}
    }));

    // 2. Récupérer aussi les événements personnalisés du journal Wialon de l'unité via messages/load_interval (flags 0x0600)
    const wialonEvents = [];
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const fromSec = nowSec - 90 * 86400; // 90 derniers jours
      const loadRes = await api().call('messages/load_interval', {
        itemId: unit.id,
        timeFrom: fromSec,
        timeTo: nowSec + 3600,
        flags: 0x0600,
        flagsMask: 0xFF00,
        loadCount: 30
      });
      if (loadRes && Array.isArray(loadRes.messages)) {
        for (const msg of loadRes.messages) {
          if (!msg) continue;
          const desc = msg.et || (msg.p && (msg.p.desc || msg.p.description || msg.p.text)) || '';
          if (desc) {
            wialonEvents.push({
              timestamp: msg.t || 0,
              date: msg.t ? new Date(msg.t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—',
              description: String(desc)
            });
          }
        }
        wialonEvents.sort((a, b) => b.timestamp - a.timestamp);
      }
      api().call('messages/unload', {}).catch(() => {});
    } catch (_e) {}

    return {
      entries,
      wialonEvents
    };
  }

  async function deleteUnitJournalEntry(unit, entryId, primaryResource) {
    const currentIndex = getUnitPhotoJournalIndex(unit);
    const target = currentIndex.find(item => item.id === entryId);
    const nextIndex = currentIndex
      .filter(item => item.id !== entryId)
      .map(it => {
        const copy = { ...it };
        delete copy.dataUrl;
        return copy;
      });

    photoMemoryCache.delete(entryId);

    const calls = [
      ...buildChunkedFieldWriteCalls(unit.raw, `_igeo_ph_${entryId}`, '', 'aflds'),
      ...buildChunkedFieldWriteCalls(
        unit.raw,
        PHOTO_JOURNAL_FIELD,
        nextIndex.length ? JSON.stringify(nextIndex) : '',
        'aflds'
      )
    ];

    if (calls.length) {
      const resList = await api().batchChunked(calls.map(c => ({ svc: c.svc, params: c.params })));
      resList.forEach((r, idx) => {
        if (!r || !r.error) applyLocalFieldMutation(calls[idx]._meta, r);
      });
    }

    fetch(`/photo/${encodeURIComponent(unit.id)}/${encodeURIComponent(entryId)}`, { method: 'DELETE' }).catch(() => {});

    if (target && target.filePath) {
      api().call('file/rm', {
        itemId: target.storageItemId || unit.id,
        storageType: 1,
        path: target.filePath
      }).catch(() => {});
    }

    return nextIndex;
  }

  // Groupes multi-clients détectés : Map(groupId → [noms des groupes entièrement contenus]).
  // Règle : le groupe contient entièrement au moins 2 autres groupes et son nom n'est pas au format
  // « [CLIENT] ». Jumelle : igeo-rapports/public/js/groupe_client.js (garder la même règle).
  function detectMultiClientGroups(groups) {
    const list = (groups || []).map(g => ({ id: Number(g.id), name: g.name || '', units: new Set((g.unitIds || []).map(Number)) }));
    const res = new Map();
    for (const g of list) {
      if (g.units.size < 2 || /^\s*\[.*\]\s*$/.test(g.name)) continue;
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

  window.AdminEngine = {
    USER_ROLES,
    JOURNAL_CATEGORIES,
    DEFAULT_COMMANDS,
    DEFAULT_SCHEMA,
    normalizeKey,
    canonicalToken,
    findFieldEntry,
    findAllMatchingEntries,
    parseBoolValue,
    getFieldRawValue,
    getUserRole,
    evaluatePermission,
    detectMultiClientGroups,
    validateFieldValue,
    getMissingRequiredFields,
    loadAllData,
    updateFieldOnEntities,
    saveCommandPolicies,
    evaluateUserCommandAccess,
    updateUserCommandOverride,
    canUndo,
    peekUndo,
    undoLastAction,
    unifyAndDeduplicateField,
    saveSchema,
    getUnitSwapHistory,
    replaceUnitImei,
    compressImageFile,
    getUnitPhotoJournalIndex,
    addUnitJournalPhoto,
    loadUnitJournalDetails,
    deleteUnitJournalEntry,
    REQUIRED_REPORT_ACCESS_MASK,
    getUserReportAccess,
    unlockUserReportAccess,
    unlockAllUsersReportAccess
  };
})();
