/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * APPLICATION PRINCIPALE — IGEO ADMIN STUDIO (admin.igeopilot.com)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Interface ludique de gestion :
 *  1) Matrice interactive type Notion/Airtable (Véhicules, Groupes, Utilisateurs)
 *     avec switchs 1-clic, héritage Groupe -> Véhicule, champs typés inline,
 *     filtre "Champs obligatoires manquants" et barre d'actions en lot (Bulk Edit).
 *  2) Fiche latérale détaillée avec Assistant de Remplacement d'IMEI (Swap Boîtier)
 *     et historique complet des remplacements.
 *  3) Studio de création dynamique de Permissions, Champs typés (Date, Nombre,
 *     Liste, Texte, Obligatoire) et Règles.
 */
(function () {
  const api = window.IgeoApi;
  const engine = window.AdminEngine;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const state = {
    session: null,
    loading: false,
    loginError: '',
    activeTab: 'unit', // 'unit' | 'group' | 'user' | 'studio'
    search: '',
    quickFilter: 'all', // 'all' | 'missing_req' | 'ecodrive' | 'carburant'
    groupByGroup: true,
    collapsedGroups: new Set(),
    units: [],
    groups: [],
    groupsById: new Map(),
    users: [],
    resources: [],
    primaryResource: null,
    hwTypes: [],
    hwById: new Map(),
    schema: engine.DEFAULT_SCHEMA.slice(),
    selectedIds: new Set(),
    drawer: null, // { entityType, entityId, focusSwap: boolean }
    bulkFieldKey: 'ecodrive',
    bulkValue: 'oui'
  };

  function root() {
    return $('#adm-app');
  }

  function toast(message, type = 'success') {
    const container = $('#adm-toast-container');
    if (!container) return;
    const icon = type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'check_circle';
    const el = document.createElement('div');
    el.className = `adm-toast ${type}`;
    el.innerHTML = `<span class="ms">${icon}</span><span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 3600);
  }

  function renderTopbar() {
    const themeSlot = $('#adm-theme-slot');
    if (themeSlot) {
      const isDark = document.documentElement.classList.contains('dark');
      themeSlot.innerHTML = `
        <button type="button" class="adm-btn ghost" id="adm-theme-btn" title="Basculer le thème clair / sombre">
          <span class="ms">${isDark ? 'light_mode' : 'dark_mode'}</span>
        </button>`;
      $('#adm-theme-btn').addEventListener('click', () => {
        const nextDark = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', nextDark);
        try { localStorage.setItem('igeo_theme', nextDark ? 'dark' : 'light'); } catch (_e) {}
        renderTopbar();
      });
    }

    const userSlot = $('#adm-user-slot');
    if (userSlot) {
      if (state.session) {
        userSlot.innerHTML = `
          <button type="button" class="adm-btn" id="adm-refresh-btn" title="Rafraîchir les données depuis Wialon">
            <span class="ms">refresh</span> Synchroniser
          </button>
          <span class="adm-filter-pill" style="cursor:default;">
            <span class="ms" style="font-size:16px;color:var(--primary);">verified_user</span>
            ${esc(state.session.userName)}
          </span>
          <button type="button" class="adm-btn ghost" id="adm-logout-btn" title="Se déconnecter">
            <span class="ms">logout</span>
          </button>`;
        $('#adm-refresh-btn').addEventListener('click', () => refreshWorkspaceData(true));
        $('#adm-logout-btn').addEventListener('click', () => logout());
      } else {
        userSlot.innerHTML = '';
      }
    }
  }

  // ── Démarrage & Authentification ────────────────────────────────────────────
  async function boot() {
    renderTopbar();
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('access_token') || params.get('token');
    const urlSid = params.get('sid');

    if (urlToken || urlSid) {
      history.replaceState({}, document.title, location.pathname);
    }

    const token = urlToken || api.storedToken();
    if (token || urlSid) {
      renderLoading('Connexion administrateur à Igeo (Wialon)…');
      try {
        state.session = token
          ? await api.loginWithToken(token)
          : await api.useExistingSession(urlSid);
        await enterWorkspace();
        return;
      } catch (e) {
        state.loginError = e.message || 'Session expirée ou invalide.';
      }
    }
    renderLogin();
  }

  function renderLoading(msg) {
    root().innerHTML = `
      <div class="adm-login-wrap">
        <div class="adm-login-card">
          <img src="img/igeo_logo.png" alt="Igeo">
          <h1>Chargement en cours…</h1>
          <p>${esc(msg || 'Synchronisation avec Igeo…')}</p>
        </div>
      </div>`;
  }

  function renderLogin() {
    renderTopbar();
    const redirectUri = location.origin + location.pathname;
    root().innerHTML = `
      <div class="adm-login-wrap">
        <div class="adm-login-card">
          <img src="img/igeo_logo.png" alt="Igeo">
          <h1>Igeo Studio · Administration</h1>
          <p>Gérez visuellement les permissions d’accès aux rapports (Éco-conduite, Carburant), les champs typés obligatoires et les remplacements d’IMEI.</p>
          ${state.loginError ? `<div class="adm-req-badge missing" style="margin-bottom:14px;padding:8px 12px;display:flex;justify-content:center;">${esc(state.loginError)}</div>` : ''}
          <div class="adm-login-actions">
            <a class="adm-btn primary" href="${esc(api.buildLoginUrl(redirectUri))}" style="height:40px;font-size:13.5px;">
              <span class="ms">login</span> Se connecter avec un compte Igeo
            </a>
            <button type="button" class="adm-btn" id="adm-popup-login" style="height:38px;">
              <span class="ms">open_in_new</span> Connexion par fenêtre popup
            </button>
          </div>
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);text-align:left;">
            <label style="font-size:11.5px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:6px;">Ou coller un jeton (token) Wialon :</label>
            <div style="display:flex;gap:6px;">
              <input type="password" id="adm-manual-token" class="adm-input" style="flex:1;" placeholder="Token Wialon (64 caractères hex)…">
              <button type="button" class="adm-btn primary" id="adm-token-btn">Valider</button>
            </div>
          </div>
        </div>
      </div>`;

    $('#adm-popup-login').addEventListener('click', async () => {
      try {
        const tok = await api.loginWithPopup();
        renderLoading('Ouverture de la session…');
        state.session = await api.loginWithToken(tok);
        await enterWorkspace();
      } catch (e) {
        if (e && e.message !== 'popup-closed') {
          state.loginError = 'La fenêtre de connexion a été bloquée ou a échoué.';
          renderLogin();
        }
      }
    });

    $('#adm-token-btn').addEventListener('click', async () => {
      const tok = ($('#adm-manual-token').value || '').trim();
      if (!tok) return;
      renderLoading('Vérification du jeton…');
      try {
        state.session = await api.loginWithToken(tok);
        await enterWorkspace();
      } catch (e) {
        state.loginError = e.message || 'Jeton invalide.';
        renderLogin();
      }
    });
  }

  async function logout(errMsg = '') {
    await api.logout();
    state.session = null;
    state.loginError = errMsg;
    state.selectedIds.clear();
    state.drawer = null;
    renderLogin();
  }

  async function enterWorkspace() {
    await refreshWorkspaceData(false);
  }

  async function refreshWorkspaceData(showNotification = false) {
    renderTopbar();
    if (!state.units.length) {
      renderLoading('Chargement des véhicules, groupes, utilisateurs et schémas Wialon…');
    }
    try {
      const data = await engine.loadAllData();
      state.units = data.units;
      state.groups = data.groups;
      state.groupsById = data.groupsById;
      state.users = data.users;
      state.resources = data.resources;
      state.primaryResource = data.primaryResource;
      state.hwTypes = data.hwTypes;
      state.hwById = data.hwById;
      state.schema = data.schema;
      renderWorkspace();
      if (showNotification) toast('Données synchronisées avec Wialon');
    } catch (e) {
      if (e && e.code === 1) return logout('Session expirée, veuillez vous reconnecter.');
      toast(e.message || 'Erreur lors du chargement des données', 'error');
      renderWorkspace();
    }
  }

  // ── Accès aux entités et colonnes selon l'onglet actif ──────────────────────
  function currentEntities() {
    if (state.activeTab === 'group') return state.groups;
    if (state.activeTab === 'user') return state.users;
    return state.units;
  }

  function findEntity(entityType, entityId) {
    const id = Number(entityId);
    if (entityType === 'group') return state.groups.find(g => g.id === id);
    if (entityType === 'user') return state.users.find(u => u.id === id);
    return state.units.find(u => u.id === id);
  }

  function currentFieldsForTab(tab = state.activeTab) {
    return state.schema.filter(f => Array.isArray(f.targets) && f.targets.includes(tab));
  }

  function filteredEntities() {
    const list = currentEntities();
    const q = state.search.trim().toLowerCase();

    return list.filter(ent => {
      if (state.quickFilter === 'missing_req') {
        const missing = engine.getMissingRequiredFields(ent, state.schema);
        if (!missing.length) return false;
      } else if (state.quickFilter === 'ecodrive') {
        const f = state.schema.find(s => s.key === 'ecodrive');
        if (f && !engine.evaluatePermission(ent, f, state.groupsById).effective) return false;
      } else if (state.quickFilter === 'carburant') {
        const f = state.schema.find(s => s.key === 'carburant');
        if (f && !engine.evaluatePermission(ent, f, state.groupsById).effective) return false;
      }

      if (!q) return true;
      const inName = (ent.name || '').toLowerCase().includes(q);
      const inImei = (ent.imei || '').toLowerCase().includes(q);
      const inGroups = Array.isArray(ent.groupNames) && ent.groupNames.some(gn => gn.toLowerCase().includes(q));
      return inName || inImei || inGroups;
    });
  }

  // ── Rendu de l'espace de travail principal ──────────────────────────────────
  function renderWorkspace() {
    renderTopbar();

    const ecoField = state.schema.find(f => f.key === 'ecodrive') || { key: 'ecodrive', storage: 'aflds' };
    const fuelField = state.schema.find(f => f.key === 'carburant') || { key: 'carburant', storage: 'aflds' };

    const ecoCount = state.units.filter(u => engine.evaluatePermission(u, ecoField, state.groupsById).effective).length;
    const fuelCount = state.units.filter(u => engine.evaluatePermission(u, fuelField, state.groupsById).effective).length;
    const missingReqCount = state.units.filter(u => engine.getMissingRequiredFields(u, state.schema).length > 0).length;

    root().innerHTML = `
      <div class="adm-workspace">
        <!-- Bandeau KPI cliquables -->
        <div class="adm-kpi-strip">
          <div class="adm-kpi-card ${state.activeTab === 'unit' && state.quickFilter === 'all' ? 'active-filter' : ''}" data-kpi-filter="all">
            <div class="adm-kpi-icon" style="background:rgba(35,131,226,0.12);color:#2383e2;"><span class="ms">directions_car</span></div>
            <div>
              <div class="adm-kpi-val">${state.units.length}</div>
              <div class="adm-kpi-lbl">Véhicules dans le parc (${state.groups.length} groupes)</div>
            </div>
          </div>
          <div class="adm-kpi-card ${state.quickFilter === 'ecodrive' ? 'active-filter' : ''}" data-kpi-filter="ecodrive">
            <div class="adm-kpi-icon" style="background:rgba(22,163,74,0.12);color:#16a34a;"><span class="ms">eco</span></div>
            <div>
              <div class="adm-kpi-val">${ecoCount} / ${state.units.length}</div>
              <div class="adm-kpi-lbl">Activés Éco-conduite (EC04)</div>
            </div>
          </div>
          <div class="adm-kpi-card ${state.quickFilter === 'carburant' ? 'active-filter' : ''}" data-kpi-filter="carburant">
            <div class="adm-kpi-icon" style="background:rgba(37,99,235,0.12);color:#2563eb;"><span class="ms">local_gas_station</span></div>
            <div>
              <div class="adm-kpi-val">${fuelCount} / ${state.units.length}</div>
              <div class="adm-kpi-lbl">Activés Gestion Carburant (V20)</div>
            </div>
          </div>
          <div class="adm-kpi-card ${state.quickFilter === 'missing_req' ? 'active-filter' : ''}" data-kpi-filter="missing_req">
            <div class="adm-kpi-icon" style="background:rgba(217,119,6,0.14);color:#d97706;"><span class="ms">assignment_late</span></div>
            <div>
              <div class="adm-kpi-val">${missingReqCount}</div>
              <div class="adm-kpi-lbl">Champs obligatoires à compléter</div>
            </div>
          </div>
        </div>

        <!-- Navigation par Onglets -->
        <div class="adm-nav-row">
          <div class="adm-tabs">
            <button type="button" class="adm-tab ${state.activeTab === 'unit' ? 'active' : ''}" data-tab="unit">
              <span class="ms">directions_car</span> Véhicules <span class="count">${state.units.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'group' ? 'active' : ''}" data-tab="group">
              <span class="ms">folder</span> Groupes (Héritage) <span class="count">${state.groups.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'user' ? 'active' : ''}" data-tab="user">
              <span class="ms">group</span> Utilisateurs <span class="count">${state.users.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'studio' ? 'active' : ''}" data-tab="studio">
              <span class="ms">auto_Fix_high</span> Studio Permissions & Champs <span class="count">${state.schema.length}</span>
            </button>
          </div>

          <div style="display:flex;gap:8px;align-items:center;">
            <button type="button" class="adm-btn primary" id="adm-new-field-shortcut">
              <span class="ms">add_circle</span> + Nouvelle permission / champ
            </button>
          </div>
        </div>

        <!-- Contenu principal -->
        <div id="adm-tab-content"></div>
      </div>

      <div id="adm-bulk-slot"></div>
      <div id="adm-drawer-slot"></div>
    `;

    // Listeners KPI cards
    $$('[data-kpi-filter]').forEach(card => {
      card.addEventListener('click', () => {
        const f = card.getAttribute('data-kpi-filter');
        state.activeTab = 'unit';
        state.quickFilter = (state.quickFilter === f && f !== 'all') ? 'all' : f;
        state.selectedIds.clear();
        renderWorkspace();
      });
    });

    // Listeners Onglets
    $$('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab === state.activeTab) return;
        state.activeTab = tab;
        state.selectedIds.clear();
        renderWorkspace();
      });
    });

    $('#adm-new-field-shortcut').addEventListener('click', () => {
      state.activeTab = 'studio';
      renderWorkspace();
      const input = $('#studio-label');
      if (input) input.focus();
    });

    if (state.activeTab === 'studio') {
      renderStudioView();
    } else {
      renderMatrixView();
    }

    renderBulkBar();
    renderDrawer();
  }

  // ── VUE 1 : MATRICE INTERACTIVE (Véhicules, Groupes, Utilisateurs) ──────────
  function renderMatrixView() {
    const slot = $('#adm-tab-content');
    if (!slot) return;

    const fields = currentFieldsForTab(state.activeTab);
    const entities = filteredEntities();
    const allVisibleSelected = entities.length > 0 && entities.every(e => state.selectedIds.has(e.id));

    slot.innerHTML = `
      <div class="adm-toolbar">
        <div class="adm-search-box">
          <span class="ms">search</span>
          <input type="search" class="adm-input" id="adm-search-input" placeholder="Rechercher par nom, plaque, IMEI ou groupe…" value="${esc(state.search)}">
        </div>

        <button type="button" class="adm-filter-pill ${state.quickFilter === 'all' ? 'active' : ''}" data-qfilter="all">
          Tous (${currentEntities().length})
        </button>
        <button type="button" class="adm-filter-pill warn ${state.quickFilter === 'missing_req' ? 'active' : ''}" data-qfilter="missing_req">
          <span class="ms" style="font-size:15px;">warning</span> Obligatoires manquants
        </button>
        ${state.activeTab !== 'user' ? `
          <button type="button" class="adm-filter-pill ${state.quickFilter === 'ecodrive' ? 'active' : ''}" data-qfilter="ecodrive">
            <span class="ms" style="font-size:15px;color:#16a34a;">eco</span> Éco-conduite actif
          </button>
          <button type="button" class="adm-filter-pill ${state.quickFilter === 'carburant' ? 'active' : ''}" data-qfilter="carburant">
            <span class="ms" style="font-size:15px;color:#2563eb;">local_gas_station</span> Carburant actif
          </button>
        ` : ''}

        ${state.activeTab === 'unit' ? `
          <button type="button" class="adm-btn sm" id="adm-toggle-grouping" title="Activer/désactiver le regroupement par groupe">
            <span class="ms">${state.groupByGroup ? 'folder_open' : 'view_list'}</span>
            ${state.groupByGroup ? 'Groupé par dossier' : 'Vue à plat'}
          </button>
        ` : ''}
      </div>

      <div class="adm-matrix-card" style="margin-top:12px;">
        <div class="adm-matrix-scroll">
          <table class="adm-matrix">
            <thead>
              <tr>
                <th style="width:36px;text-align:center;">
                  <input type="checkbox" id="adm-check-all" ${allVisibleSelected ? 'checked' : ''} title="Tout sélectionner">
                </th>
                <th>${state.activeTab === 'unit' ? 'Véhicule & Boîtier' : state.activeTab === 'group' ? 'Groupe de véhicules' : 'Utilisateur Wialon'}</th>
                <th>Conformité</th>
                ${fields.map(f => `
                  <th>
                    <div style="display:inline-flex;align-items:center;gap:5px;">
                      <span class="ms" style="font-size:15px;color:${esc(f.color || 'var(--primary)')}">${esc(f.icon || 'tune')}</span>
                      <span>${esc(f.label)}</span>
                      ${f.required ? '<span class="adm-req-star" title="Champ obligatoire">*</span>' : ''}
                    </div>
                  </th>
                `).join('')}
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody id="adm-matrix-tbody">
              ${renderMatrixRowsHtml(entities, fields)}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Search input
    const searchInput = $('#adm-search-input');
    searchInput.addEventListener('input', (e) => {
      state.search = e.target.value;
      $('#adm-matrix-tbody').innerHTML = renderMatrixRowsHtml(filteredEntities(), fields);
      bindMatrixRowEvents();
    });

    // Quick filters
    $$('[data-qfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.quickFilter = btn.getAttribute('data-qfilter');
        renderWorkspace();
      });
    });

    // Toggle grouping
    const grpBtn = $('#adm-toggle-grouping');
    if (grpBtn) {
      grpBtn.addEventListener('click', () => {
        state.groupByGroup = !state.groupByGroup;
        renderMatrixView();
      });
    }

    // Select all
    $('#adm-check-all').addEventListener('change', (e) => {
      const vis = filteredEntities();
      if (e.target.checked) {
        vis.forEach(item => state.selectedIds.add(item.id));
      } else {
        vis.forEach(item => state.selectedIds.delete(item.id));
      }
      renderMatrixView();
      renderBulkBar();
    });

    bindMatrixRowEvents();
  }

  function renderMatrixRowsHtml(entities, fields) {
    const colCount = fields.length + 4;
    if (!entities.length) {
      return `<tr><td colspan="${colCount}" class="adm-empty">Aucun élément ne correspond aux critères actuels.</td></tr>`;
    }

    if (state.activeTab === 'unit' && state.groupByGroup && state.groups.length > 0) {
      const entityById = new Map(entities.map(u => [u.id, u]));
      const assigned = new Set();
      const blocks = [];

      const sortedGroups = [...state.groups].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      for (const g of sortedGroups) {
        const gUnits = g.unitIds.map(id => entityById.get(id)).filter(Boolean);
        if (!gUnits.length) continue;
        gUnits.forEach(u => assigned.add(u.id));

        const gKey = String(g.id);
        const collapsed = state.collapsedGroups.has(gKey);
        const ecoField = state.schema.find(f => f.key === 'ecodrive');
        const fuelField = state.schema.find(f => f.key === 'carburant');
        const gEco = ecoField && engine.evaluatePermission(g, ecoField, null).effective;
        const gFuel = fuelField && engine.evaluatePermission(g, fuelField, null).effective;

        blocks.push(`
          <tr class="adm-group-banner" data-group-banner="${g.id}">
            <td colspan="${colCount}">
              <div class="adm-group-banner-inner">
                <button type="button" class="adm-btn ghost sm" data-toggle-group="${gKey}">
                  <span class="ms">${collapsed ? 'chevron_right' : 'expand_more'}</span>
                  <span class="ms" style="color:var(--primary);">folder</span>
                  <strong>${esc(g.name)}</strong>
                  <span class="adm-imei-badge">${gUnits.length} véh.</span>
                </button>
                <span style="font-size:11.5px;color:var(--text-muted);">Héritage du groupe :</span>
                ${ecoField ? `
                  <button type="button" class="adm-filter-pill ${gEco ? 'active' : ''}" style="height:25px;font-size:11px;" data-group-quick-perm="${g.id}:ecodrive" title="Cliquer pour activer/désactiver Éco-conduite sur tout le groupe ${esc(g.name)}">
                    <span class="ms" style="font-size:14px;color:#16a34a;">eco</span> Éco-conduite : ${gEco ? 'OUI (hérité)' : 'NON'}
                  </button>` : ''}
                ${fuelField ? `
                  <button type="button" class="adm-filter-pill ${gFuel ? 'active' : ''}" style="height:25px;font-size:11px;" data-group-quick-perm="${g.id}:carburant" title="Cliquer pour activer/désactiver Carburant sur tout le groupe ${esc(g.name)}">
                    <span class="ms" style="font-size:14px;color:#2563eb;">local_gas_station</span> Carburant : ${gFuel ? 'OUI (hérité)' : 'NON'}
                  </button>` : ''}
                <button type="button" class="adm-btn ghost sm" data-select-group-units="${g.id}" style="margin-left:auto;">
                  Sélectionner les ${gUnits.length} véhicules
                </button>
              </div>
            </td>
          </tr>
        `);

        if (!collapsed) {
          for (const u of gUnits) {
            blocks.push(renderSingleEntityRowHtml(u, fields));
          }
        }
      }

      const ungrouped = entities.filter(u => !assigned.has(u.id));
      if (ungrouped.length) {
        const collapsed = state.collapsedGroups.has('ungrouped');
        blocks.push(`
          <tr class="adm-group-banner">
            <td colspan="${colCount}">
              <div class="adm-group-banner-inner">
                <button type="button" class="adm-btn ghost sm" data-toggle-group="ungrouped">
                  <span class="ms">${collapsed ? 'chevron_right' : 'expand_more'}</span>
                  <span class="ms">devices_other</span>
                  <strong>Hors groupe / Non classés</strong>
                  <span class="adm-imei-badge">${ungrouped.length} véh.</span>
                </button>
              </div>
            </td>
          </tr>
        `);
        if (!collapsed) {
          for (const u of ungrouped) {
            blocks.push(renderSingleEntityRowHtml(u, fields));
          }
        }
      }

      return blocks.join('');
    }

    return entities.map(ent => renderSingleEntityRowHtml(ent, fields)).join('');
  }

  function renderSingleEntityRowHtml(ent, fields) {
    const missing = engine.getMissingRequiredFields(ent, state.schema);
    const checked = state.selectedIds.has(ent.id);

    let subLine = '';
    if (ent.entityType === 'unit') {
      subLine = `
        <span class="adm-imei-badge" title="Identifiant boîtier (IMEI)">IMEI: ${esc(ent.imei || 'Aucun')}</span>
        <span>${esc(ent.hwName)}</span>
      `;
    } else if (ent.entityType === 'group') {
      subLine = `<span>${ent.unitIds.length} véhicule(s) rattaché(s)</span>`;
    } else {
      subLine = `<span>ID Wialon #${ent.id}</span>`;
    }

    return `
      <tr class="adm-row" data-entity-type="${ent.entityType}" data-entity-id="${ent.id}">
        <td style="text-align:center;">
          <input type="checkbox" class="adm-row-check" data-check-id="${ent.id}" ${checked ? 'checked' : ''}>
        </td>
        <td>
          <div class="adm-entity-cell">
            <div>
              <div class="adm-entity-title" data-open-drawer="${ent.entityType}:${ent.id}">${esc(ent.name)}</div>
              <div class="adm-entity-sub">${subLine}</div>
            </div>
          </div>
        </td>
        <td>
          ${missing.length === 0
            ? `<span class="adm-req-badge ok"><span class="ms" style="font-size:13px;">check_circle</span> Complet</span>`
            : `<span class="adm-req-badge missing" title="Manquant : ${esc(missing.map(m => m.label).join(', '))}">
                <span class="ms" style="font-size:13px;">warning</span> ${missing.length} obligatoire(s)
              </span>`
          }
        </td>
        ${fields.map(f => `<td>${renderMatrixCellControlHtml(ent, f)}</td>`).join('')}
        <td style="text-align:right;white-space:nowrap;">
          ${ent.entityType === 'unit' ? `
            <button type="button" class="adm-btn sm" data-open-swap="${ent.id}" title="Remplacer l'IMEI du boîtier sur ce véhicule">
              <span class="ms" style="font-size:15px;color:var(--primary);">swap_horiz</span> Swap IMEI
            </button>
          ` : ''}
          <button type="button" class="adm-btn sm ghost" data-open-drawer="${ent.entityType}:${ent.id}" title="Ouvrir la fiche complète">
            <span class="ms" style="font-size:16px;">tune</span> Fiche
          </button>
        </td>
      </tr>
    `;
  }

  function renderMatrixCellControlHtml(ent, fieldDef) {
    if (fieldDef.type === 'boolean') {
      const perm = engine.evaluatePermission(ent, fieldDef, state.groupsById);
      const swColor = fieldDef.color || '#16a34a';
      let badgeHtml = '';

      if (ent.entityType === 'unit') {
        if (perm.own === null && perm.inheritedFrom) {
          badgeHtml = `<span class="adm-perm-tag inherited" title="Hérité du groupe ${esc(perm.inheritedFrom)}">Hérité : OUI</span>`;
        } else if (perm.own === true) {
          badgeHtml = `
            <span class="adm-perm-tag explicit-on">OUI</span>
            <button type="button" class="adm-reset-inherit" data-reset-field="${ent.entityType}:${ent.id}:${fieldDef.key}" title="Effacer et revenir à l'héritage du groupe">
              <span class="ms" style="font-size:14px;">restart_alt</span>
            </button>`;
        } else if (perm.own === false) {
          badgeHtml = `
            <span class="adm-perm-tag explicit-off">NON (forcé)</span>
            <button type="button" class="adm-reset-inherit" data-reset-field="${ent.entityType}:${ent.id}:${fieldDef.key}" title="Effacer et revenir à l'héritage du groupe">
              <span class="ms" style="font-size:14px;">restart_alt</span>
            </button>`;
        } else {
          badgeHtml = `<span class="adm-perm-tag unset">Non</span>`;
        }
      } else {
        badgeHtml = perm.effective
          ? `<span class="adm-perm-tag explicit-on">OUI</span>`
          : `<span class="adm-perm-tag unset">Non</span>`;
      }

      return `
        <div class="adm-perm-cell">
          <button type="button"
            class="adm-switch ${perm.effective ? 'on' : ''}"
            style="--sw-color:${esc(swColor)};"
            data-toggle-perm="${ent.entityType}:${ent.id}:${fieldDef.key}"
            title="Cliquer pour basculer ${esc(fieldDef.label)}">
          </button>
          ${badgeHtml}
        </div>
      `;
    }

    const rawVal = engine.getFieldRawValue(ent, fieldDef);
    const isMissingReq = fieldDef.required && !rawVal;

    if (fieldDef.type === 'date') {
      return `
        <input type="date"
          class="adm-inline-input ${isMissingReq ? 'missing-req' : ''}"
          value="${esc(rawVal)}"
          data-inline-field="${ent.entityType}:${ent.id}:${fieldDef.key}"
          title="${isMissingReq ? 'Champ obligatoire manquant' : esc(fieldDef.label)}">
      `;
    }

    if (fieldDef.type === 'select') {
      const opts = Array.isArray(fieldDef.options) ? fieldDef.options : [];
      return `
        <select class="adm-inline-input ${isMissingReq ? 'missing-req' : ''}"
          data-inline-field="${ent.entityType}:${ent.id}:${fieldDef.key}">
          <option value="">— Choisir —</option>
          ${opts.map(opt => `<option value="${esc(opt)}" ${rawVal === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        </select>
      `;
    }

    return `
      <input type="${fieldDef.type === 'number' ? 'number' : 'text'}"
        class="adm-inline-input ${isMissingReq ? 'missing-req' : ''}"
        value="${esc(rawVal)}"
        placeholder="${fieldDef.required ? 'Obligatoire…' : '—'}"
        data-inline-field="${ent.entityType}:${ent.id}:${fieldDef.key}">
    `;
  }

  function bindMatrixRowEvents() {
    const tbody = $('#adm-matrix-tbody');
    if (!tbody) return;

    // Sélection ligne
    $$('.adm-row-check', tbody).forEach(chk => {
      chk.addEventListener('change', () => {
        const id = Number(chk.getAttribute('data-check-id'));
        if (chk.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        renderBulkBar();
      });
    });

    // Plier / déplier un groupe dans la matrice
    $$('[data-toggle-group]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const gKey = btn.getAttribute('data-toggle-group');
        if (state.collapsedGroups.has(gKey)) state.collapsedGroups.delete(gKey);
        else state.collapsedGroups.add(gKey);
        renderMatrixView();
      });
    });

    // Sélectionner tous les véhicules d'un groupe
    $$('[data-select-group-units]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const gId = Number(btn.getAttribute('data-select-group-units'));
        const g = state.groupsById.get(gId);
        if (!g) return;
        g.unitIds.forEach(id => state.selectedIds.add(id));
        renderMatrixView();
        renderBulkBar();
      });
    });

    // Switch rapide sur l'en-tête d'un groupe
    $$('[data-group-quick-perm]', tbody).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [gIdStr, fKey] = btn.getAttribute('data-group-quick-perm').split(':');
        const g = state.groupsById.get(Number(gIdStr));
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!g || !fieldDef) return;
        const curr = engine.evaluatePermission(g, fieldDef, null).effective;
        const nextVal = curr ? 'non' : 'oui';
        try {
          await engine.updateFieldOnEntities([g], fieldDef, nextVal);
          toast(`${fieldDef.label} → ${nextVal.toUpperCase()} sur le groupe « ${g.name} »`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Switch 1-clic d'une permission sur une ligne
    $$('[data-toggle-perm]', tbody).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [eType, eIdStr, fKey] = btn.getAttribute('data-toggle-perm').split(':');
        const ent = findEntity(eType, eIdStr);
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!ent || !fieldDef) return;
        const perm = engine.evaluatePermission(ent, fieldDef, state.groupsById);
        const nextVal = perm.effective ? 'non' : 'oui';
        btn.disabled = true;
        try {
          await engine.updateFieldOnEntities([ent], fieldDef, nextVal);
          toast(`${ent.name} · ${fieldDef.label} = ${nextVal.toUpperCase()}`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // Reset à l'héritage du groupe
    $$('[data-reset-field]', tbody).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [eType, eIdStr, fKey] = btn.getAttribute('data-reset-field').split(':');
        const ent = findEntity(eType, eIdStr);
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!ent || !fieldDef) return;
        try {
          await engine.updateFieldOnEntities([ent], fieldDef, '');
          toast(`${ent.name} · ${fieldDef.label} réinitialisé à l'héritage du groupe`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Édition inline d'un champ typé (date, select, number, text)
    $$('[data-inline-field]', tbody).forEach(input => {
      input.addEventListener('change', async () => {
        const [eType, eIdStr, fKey] = input.getAttribute('data-inline-field').split(':');
        const ent = findEntity(eType, eIdStr);
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!ent || !fieldDef) return;
        const val = input.value.trim();
        try {
          await engine.updateFieldOnEntities([ent], fieldDef, val);
          toast(`${ent.name} · ${fieldDef.label} enregistré`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
          input.value = engine.getFieldRawValue(ent, fieldDef);
        }
      });
    });

    // Ouvrir le tiroir Fiche détaillée
    $$('[data-open-drawer]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const [eType, eIdStr] = btn.getAttribute('data-open-drawer').split(':');
        state.drawer = { entityType: eType, entityId: Number(eIdStr), focusSwap: false };
        renderDrawer();
      });
    });

    // Ouvrir directement l'assistant Swap IMEI
    $$('[data-open-swap]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-open-swap'));
        state.drawer = { entityType: 'unit', entityId: id, focusSwap: true };
        renderDrawer();
      });
    });
  }

  // ── Barre flottante d'édition en masse (Bulk Edit) ──────────────────────────
  function renderBulkBar() {
    const slot = $('#adm-bulk-slot');
    if (!slot) return;
    if (!state.selectedIds.size || state.activeTab === 'studio') {
      slot.innerHTML = '';
      return;
    }

    const fields = currentFieldsForTab(state.activeTab);
    if (!fields.some(f => f.key === state.bulkFieldKey) && fields[0]) {
      state.bulkFieldKey = fields[0].key;
    }
    const activeField = fields.find(f => f.key === state.bulkFieldKey) || fields[0];

    let valueControlHtml = '';
    if (activeField) {
      if (activeField.type === 'boolean') {
        valueControlHtml = `
          <select class="adm-select" id="adm-bulk-val">
            <option value="oui" ${state.bulkValue === 'oui' ? 'selected' : ''}>Activer (OUI)</option>
            <option value="non" ${state.bulkValue === 'non' ? 'selected' : ''}>Désactiver (NON)</option>
            ${state.activeTab === 'unit' ? `<option value="" ${state.bulkValue === '' ? 'selected' : ''}>Hériter du groupe (Effacer)</option>` : ''}
          </select>`;
      } else if (activeField.type === 'date') {
        valueControlHtml = `<input type="date" class="adm-input" id="adm-bulk-val" value="${esc(state.bulkValue)}">`;
      } else if (activeField.type === 'select') {
        valueControlHtml = `
          <select class="adm-select" id="adm-bulk-val">
            <option value="">— Choisir —</option>
            ${(activeField.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select>`;
      } else {
        valueControlHtml = `<input type="${activeField.type === 'number' ? 'number' : 'text'}" class="adm-input" id="adm-bulk-val" placeholder="Nouvelle valeur…">`;
      }
    }

    slot.innerHTML = `
      <div class="adm-bulk-bar">
        <span class="adm-bulk-count">${state.selectedIds.size} sélectionné(s)</span>
        <span style="font-size:12px;color:var(--text-muted);font-weight:600;">Modifier en lot :</span>
        <select class="adm-select" id="adm-bulk-field">
          ${fields.map(f => `<option value="${esc(f.key)}" ${f.key === state.bulkFieldKey ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
        ${valueControlHtml}
        <button type="button" class="adm-btn primary" id="adm-bulk-apply">
          <span class="ms">done_all</span> Appliquer aux ${state.selectedIds.size} éléments
        </button>
        <button type="button" class="adm-btn ghost sm" id="adm-bulk-clear">Désélectionner</button>
      </div>
    `;

    $('#adm-bulk-field').addEventListener('change', (e) => {
      state.bulkFieldKey = e.target.value;
      const f = fields.find(x => x.key === state.bulkFieldKey);
      state.bulkValue = f && f.type === 'boolean' ? 'oui' : '';
      renderBulkBar();
    });

    $('#adm-bulk-clear').addEventListener('click', () => {
      state.selectedIds.clear();
      renderMatrixView();
      renderBulkBar();
    });

    $('#adm-bulk-apply').addEventListener('click', async () => {
      const valEl = $('#adm-bulk-val');
      const val = valEl ? valEl.value : '';
      const entities = currentEntities().filter(e => state.selectedIds.has(e.id));
      if (!entities.length || !activeField) return;
      const btn = $('#adm-bulk-apply');
      btn.disabled = true;
      try {
        await engine.updateFieldOnEntities(entities, activeField, val);
        toast(`Champ « ${activeField.label} » mis à jour sur ${entities.length} élément(s)`);
        state.selectedIds.clear();
        renderWorkspace();
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
      }
    });
  }

  // ── VUE 2 : TIROIR LATÉRAL DÉTAILLÉ & ASSISTANT SWAP IMEI ───────────────────
  function renderDrawer() {
    const slot = $('#adm-drawer-slot');
    if (!slot) return;
    if (!state.drawer) {
      slot.innerHTML = '';
      return;
    }

    const ent = findEntity(state.drawer.entityType, state.drawer.entityId);
    if (!ent) {
      state.drawer = null;
      slot.innerHTML = '';
      return;
    }

    const fields = currentFieldsForTab(ent.entityType);
    const permFields = fields.filter(f => f.type === 'boolean');
    const dataFields = fields.filter(f => f.type !== 'boolean');
    const swapHistory = ent.entityType === 'unit' ? engine.getUnitSwapHistory(ent) : [];
    const todayIso = new Date().toISOString().slice(0, 10);

    slot.innerHTML = `
      <div class="adm-drawer-backdrop" id="adm-drawer-backdrop">
        <aside class="adm-drawer" onclick="event.stopPropagation()">
          <div class="adm-drawer-head">
            <div>
              <h2>${esc(ent.name)}</h2>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
                ${ent.entityType === 'unit'
                  ? `IMEI actuel : <strong>${esc(ent.imei || 'Aucun')}</strong> · ${esc(ent.hwName)}`
                  : ent.entityType === 'group'
                    ? `Groupe de ${ent.unitIds.length} véhicule(s)`
                    : `Utilisateur Wialon #${ent.id}`}
              </div>
            </div>
            <button type="button" class="adm-btn ghost" id="adm-drawer-close"><span class="ms">close</span></button>
          </div>

          <div class="adm-drawer-body">
            <!-- Section 1 : Permissions interactives -->
            <div class="adm-section">
              <div class="adm-section-title">
                <span class="ms" style="color:var(--primary);">verified_user</span>
                Permissions & Accès aux modules
              </div>
              ${permFields.map(f => {
                const perm = engine.evaluatePermission(ent, f, state.groupsById);
                return `
                  <div class="adm-perm-card">
                    <div class="adm-perm-card-info">
                      <span class="ms" style="color:${esc(f.color || 'var(--primary)')};font-size:22px;">${esc(f.icon || 'toggle_on')}</span>
                      <div>
                        <div style="font-weight:600;">${esc(f.label)}</div>
                        <div style="font-size:11px;color:var(--text-muted);">
                          ${perm.inheritedFrom ? `Hérité du groupe « ${esc(perm.inheritedFrom)} » (OUI)` : esc(f.description || '')}
                        </div>
                      </div>
                    </div>
                    ${ent.entityType === 'unit' ? `
                      <div class="adm-tri-segmented" data-drawer-tri="${f.key}">
                        <button type="button" class="adm-tri-btn inherit ${perm.own === null ? 'active' : ''}" data-val="">Hérité</button>
                        <button type="button" class="adm-tri-btn yes ${perm.own === true ? 'active' : ''}" data-val="oui">Oui</button>
                        <button type="button" class="adm-tri-btn no ${perm.own === false ? 'active' : ''}" data-val="non">Non</button>
                      </div>
                    ` : `
                      <div class="adm-tri-segmented" data-drawer-tri="${f.key}">
                        <button type="button" class="adm-tri-btn yes ${perm.own === true ? 'active' : ''}" data-val="oui">Oui</button>
                        <button type="button" class="adm-tri-btn no ${perm.own !== true ? 'active' : ''}" data-val="non">Non</button>
                      </div>
                    `}
                  </div>
                `;
              }).join('')}
            </div>

            <!-- Section 2 : Champs typés & Obligatoires -->
            ${dataFields.length ? `
              <div class="adm-section">
                <div class="adm-section-title">
                  <span class="ms" style="color:var(--warn);">fact_check</span>
                  Champs typés & Obligatoires
                </div>
                <div class="adm-form-grid">
                  ${dataFields.map(f => {
                    const val = engine.getFieldRawValue(ent, f);
                    const missing = f.required && !val;
                    return `
                      <div class="adm-field-group">
                        <label>
                          <span class="ms" style="font-size:15px;color:${esc(f.color || 'var(--primary)')}">${esc(f.icon || 'label')}</span>
                          ${esc(f.label)}
                          ${f.required ? '<span class="adm-req-star">* Obligatoire</span>' : ''}
                        </label>
                        ${f.type === 'select' ? `
                          <select class="adm-select ${missing ? 'missing-req' : ''}" data-drawer-field="${f.key}">
                            <option value="">— Sélectionner —</option>
                            ${(f.options || []).map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
                          </select>
                        ` : `
                          <input type="${f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}"
                            class="adm-input ${missing ? 'missing-req' : ''}"
                            value="${esc(val)}"
                            data-drawer-field="${f.key}"
                            placeholder="${f.required ? 'Champ obligatoire…' : '—'}">
                        `}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            ` : ''}

            <!-- Section 3 : Assistant de Remplacement d'IMEI (Swap de Boîtier) pour les véhicules -->
            ${ent.entityType === 'unit' ? `
              <div class="adm-swap-box" id="adm-swap-section">
                <div class="adm-section-title" style="color:var(--primary);">
                  <span class="ms">swap_horiz</span>
                  Règle métier : Remplacer l’IMEI du boîtier (Swap Balise)
                </div>
                <div style="font-size:12px;color:var(--text-muted);">
                  Remplace l’identifiant du boîtier dans Wialon, archive automatiquement l’ancien IMEI (<code>${esc(ent.imei || 'aucun')}</code>) et libère le nouvel IMEI s’il était sur une fiche stock.
                </div>
                <div class="adm-form-grid">
                  <div class="adm-field-group">
                    <label>Nouvel IMEI / ID Boîtier <span class="adm-req-star">*</span></label>
                    <input type="text" class="adm-input" id="adm-swap-new-imei" placeholder="Ex: 352093081234567">
                  </div>
                  <div class="adm-field-group">
                    <label>Date du remplacement <span class="adm-req-star">*</span></label>
                    <input type="date" class="adm-input" id="adm-swap-date" value="${todayIso}">
                  </div>
                  <div class="adm-field-group">
                    <label>Modèle de boîtier Wialon</label>
                    <select class="adm-select" id="adm-swap-hw">
                      ${state.hwTypes.length
                        ? state.hwTypes.map(hw => `<option value="${hw.id}" ${Number(hw.id) === Number(ent.hwId) ? 'selected' : ''}>${esc(hw.name)}</option>`).join('')
                        : `<option value="${ent.hwId}" selected>${esc(ent.hwName)}</option>`
                      }
                    </select>
                  </div>
                  <div class="adm-field-group">
                    <label>Motif du remplacement</label>
                    <input type="text" class="adm-input" id="adm-swap-reason" placeholder="Ex: Boîtier HS, maintenance…">
                  </div>
                </div>
                <div id="adm-swap-conflict-banner"></div>
                <div style="display:flex;justify-content:flex-end;">
                  <button type="button" class="adm-btn primary" id="adm-swap-submit">
                    <span class="ms">published_with_changes</span> Exécuter le remplacement d’IMEI
                  </button>
                </div>

                ${swapHistory.length ? `
                  <div style="margin-top:8px;padding-top:10px;border-top:1px solid var(--border);">
                    <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px;">
                      Historique des remplacements sur ce véhicule (${swapHistory.length})
                    </div>
                    <div class="adm-history-list">
                      ${swapHistory.map(h => `
                        <div class="adm-history-item">
                          <div>
                            <strong>${esc(h.oldImei)}</strong> → <strong style="color:var(--primary);">${esc(h.newImei)}</strong>
                            <div style="font-size:11px;color:var(--text-soft);">${esc(h.reason || '')}</div>
                          </div>
                          <span class="adm-imei-badge">${esc(h.date)}</span>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>
        </aside>
      </div>
    `;

    $('#adm-drawer-backdrop').addEventListener('click', () => {
      state.drawer = null;
      renderDrawer();
    });
    $('#adm-drawer-close').addEventListener('click', () => {
      state.drawer = null;
      renderDrawer();
    });

    // Tri-segmented permission buttons in drawer
    $$('[data-drawer-tri]', slot).forEach(groupEl => {
      const fKey = groupEl.getAttribute('data-drawer-tri');
      const fieldDef = state.schema.find(f => f.key === fKey);
      $$('button', groupEl).forEach(btn => {
        btn.addEventListener('click', async () => {
          const val = btn.getAttribute('data-val');
          try {
            await engine.updateFieldOnEntities([ent], fieldDef, val);
            toast(`${ent.name} · ${fieldDef.label} mis à jour`);
            renderWorkspace();
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      });
    });

    // Typed fields in drawer
    $$('[data-drawer-field]', slot).forEach(input => {
      input.addEventListener('change', async () => {
        const fKey = input.getAttribute('data-drawer-field');
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!fieldDef) return;
        try {
          await engine.updateFieldOnEntities([ent], fieldDef, input.value.trim());
          toast(`${ent.name} · ${fieldDef.label} enregistré`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
          input.value = engine.getFieldRawValue(ent, fieldDef);
        }
      });
    });

    // Assistant Swap IMEI
    if (ent.entityType === 'unit') {
      const newImeiInput = $('#adm-swap-new-imei');
      const conflictBanner = $('#adm-swap-conflict-banner');

      if (state.drawer.focusSwap && newImeiInput) {
        setTimeout(() => newImeiInput.focus(), 60);
      }

      newImeiInput.addEventListener('input', () => {
        const candidate = newImeiInput.value.trim();
        const conflict = candidate && state.units.find(u => u.id !== ent.id && (u.imei === candidate || u.imei2 === candidate));
        if (conflict) {
          conflictBanner.innerHTML = `
            <div class="adm-req-badge missing" style="padding:8px 12px;display:flex;align-items:center;gap:6px;">
              <span class="ms">info</span>
              Ce boîtier (${esc(candidate)}) est actuellement sur la fiche « ${esc(conflict.name)} ». Il sera automatiquement libéré et transféré sur « ${esc(ent.name)} ».
            </div>`;
        } else {
          conflictBanner.innerHTML = '';
        }
      });

      $('#adm-swap-submit').addEventListener('click', async () => {
        const newImei = newImeiInput.value.trim();
        const swapDate = $('#adm-swap-date').value;
        const newHwId = $('#adm-swap-hw').value;
        const reason = $('#adm-swap-reason').value.trim();
        const btn = $('#adm-swap-submit');
        btn.disabled = true;
        try {
          const res = await engine.replaceUnitImei({
            unit: ent,
            newImei,
            newHwId,
            swapDate,
            reason,
            autoFreeConflict: true,
            allUnits: state.units,
            userName: state.session ? state.session.userName : 'Admin'
          });
          toast(`Boîtier remplacé : ${res.oldImei || '—'} → ${res.newImei}`);
          state.drawer.focusSwap = false;
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      });
    }
  }

  // ── VUE 3 : STUDIO DE CRÉATION DE PERMISSIONS, CHAMPS TYPÉS & RÈGLES ────────
  function renderStudioView() {
    const slot = $('#adm-tab-content');
    if (!slot) return;

    slot.innerHTML = `
      <div class="adm-studio-grid">
        <!-- Colonne gauche : Catalogue actif des permissions et champs -->
        <div class="adm-studio-card">
          <h3><span class="ms" style="color:var(--primary);">view_column</span> Permissions & Champs actifs (${state.schema.length})</h3>
          <div style="font-size:12px;color:var(--text-muted);">
            Ces permissions et champs typés sont stockés directement dans les champs administratifs Wialon (<code>aflds</code>) et sont immédiatement exploités par <strong>rapports.igeopilot.com</strong>.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${state.schema.map(f => `
              <div class="adm-schema-item">
                <div style="display:flex;align-items:center;gap:12px;">
                  <div class="adm-kpi-icon" style="width:34px;height:34px;background:var(--bg-panel);color:${esc(f.color || 'var(--primary)')};border:1px solid var(--border);">
                    <span class="ms">${esc(f.icon || 'tune')}</span>
                  </div>
                  <div>
                    <div style="font-weight:700;display:flex;align-items:center;gap:6px;">
                      ${esc(f.label)}
                      <code class="adm-imei-badge">${esc(f.key)}</code>
                      ${f.required ? '<span class="adm-req-badge missing">Obligatoire</span>' : ''}
                    </div>
                    <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">
                      Type : <strong>${esc(f.type)}</strong> · Cibles : <strong>${esc((f.targets || []).join(', '))}</strong>
                    </div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <button type="button" class="adm-btn sm" data-toggle-req="${esc(f.key)}" title="Basculer le caractère obligatoire">
                    ${f.required ? 'Rendre facultatif' : 'Marquer obligatoire'}
                  </button>
                  ${!f.system ? `
                    <button type="button" class="adm-btn sm danger" data-delete-schema="${esc(f.key)}" title="Supprimer ce champ du studio">
                      <span class="ms" style="font-size:15px;">delete</span>
                    </button>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Colonne droite : Créateur de nouvelle permission / champ typé -->
        <div class="adm-studio-card">
          <h3><span class="ms" style="color:var(--success);">add_circle</span> Créer une Permission ou un Champ Typé</h3>
          <div class="adm-field-group">
            <label>Nom affiché <span class="adm-req-star">*</span></label>
            <input type="text" class="adm-input" id="studio-label" placeholder="Ex: Date d'installation, Coupure moteur, Numéro SIM…">
          </div>
          <div class="adm-field-group">
            <label>Clé technique Wialon (aflds) <span class="adm-req-star">*</span></label>
            <input type="text" class="adm-input" id="studio-key" placeholder="Ex: date_installation">
          </div>
          <div class="adm-form-grid">
            <div class="adm-field-group">
              <label>Type de donnée (validation stricte) <span class="adm-req-star">*</span></label>
              <select class="adm-select" id="studio-type">
                <option value="boolean">Permission Oui / Non (Switch)</option>
                <option value="date">Date uniquement (Calendrier AAAA-MM-JJ)</option>
                <option value="number">Nombre uniquement</option>
                <option value="select">Liste de choix prédéfinis</option>
                <option value="text">Texte / Identifiant</option>
              </select>
            </div>
            <div class="adm-field-group">
              <label>Icône Material & Couleur</label>
              <div style="display:flex;gap:6px;">
                <input type="text" class="adm-input" id="studio-icon" value="verified" style="flex:1;" placeholder="Icône (ex: eco, event)">
                <input type="color" class="adm-input" id="studio-color" value="#2383e2" style="width:46px;padding:2px;">
              </div>
            </div>
          </div>
          <div class="adm-field-group" id="studio-options-wrap" style="display:none;">
            <label>Options de la liste (séparées par une virgule) <span class="adm-req-star">*</span></label>
            <input type="text" class="adm-input" id="studio-options" placeholder="Ex: Actif, En maintenance, Suspendu">
          </div>
          <div class="adm-field-group">
            <label>Description / Règle d'usage</label>
            <input type="text" class="adm-input" id="studio-desc" placeholder="Ex: Date de pose initiale de la balise…">
          </div>
          <div class="adm-field-group">
            <label>Entités cibles <span class="adm-req-star">*</span></label>
            <div style="display:flex;gap:14px;padding:6px 0;">
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-unit" checked> Véhicules
              </label>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-group"> Groupes (avec héritage)
              </label>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-user"> Utilisateurs
              </label>
            </div>
          </div>
          <div class="adm-field-group">
            <label style="display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:var(--text-main);">
              <input type="checkbox" id="studio-required">
              <strong>Marquer ce champ comme obligatoire</strong> (affiche une alerte tant qu'il n'est pas renseigné)
            </label>
          </div>
          <button type="button" class="adm-btn primary" id="studio-create-btn" style="height:38px;">
            <span class="ms">save</span> Enregistrer dans le schéma Wialon
          </button>
        </div>
      </div>
    `;

    const labelIn = $('#studio-label');
    const keyIn = $('#studio-key');
    const typeSel = $('#studio-type');
    const optsWrap = $('#studio-options-wrap');

    labelIn.addEventListener('input', () => {
      keyIn.value = engine.normalizeKey(labelIn.value);
    });

    typeSel.addEventListener('change', () => {
      optsWrap.style.display = typeSel.value === 'select' ? '' : 'none';
    });

    $('#studio-create-btn').addEventListener('click', async () => {
      const label = labelIn.value.trim();
      const key = engine.normalizeKey(keyIn.value || label);
      const type = typeSel.value;
      const icon = ($('#studio-icon').value || 'tune').trim();
      const color = $('#studio-color').value || '#2383e2';
      const description = $('#studio-desc').value.trim();
      const required = $('#studio-required').checked;
      const options = ($('#studio-options').value || '').split(',').map(s => s.trim()).filter(Boolean);

      const targets = [];
      if ($('#studio-target-unit').checked) targets.push('unit');
      if ($('#studio-target-group').checked) targets.push('group');
      if ($('#studio-target-user').checked) targets.push('user');

      if (!label || !key) {
        toast('Veuillez renseigner un nom pour le champ ou la permission.', 'warn');
        return;
      }
      if (!targets.length) {
        toast('Veuillez sélectionner au moins une cible (Véhicules, Groupes ou Utilisateurs).', 'warn');
        return;
      }
      if (type === 'select' && !options.length) {
        toast('Veuillez indiquer au moins une option pour la liste de choix.', 'warn');
        return;
      }

      const nextSchema = [...state.schema.filter(f => f.key !== key), {
        key,
        label,
        description,
        type,
        options: type === 'select' ? options : undefined,
        targets,
        required,
        icon,
        color,
        storage: 'aflds',
        category: type === 'boolean' ? 'permission' : 'field',
        system: false
      }];

      state.schema = await engine.saveSchema(nextSchema, state.primaryResource);
      toast(`Champ « ${label} » ajouté au studio et synchronisé`);
      renderWorkspace();
    });

    // Basculer obligatoire
    $$('[data-toggle-req]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-toggle-req');
        const nextSchema = state.schema.map(f => f.key === key ? { ...f, required: !f.required } : f);
        state.schema = await engine.saveSchema(nextSchema, state.primaryResource);
        toast('Caractère obligatoire mis à jour');
        renderWorkspace();
      });
    });

    // Supprimer un champ personnalisé
    $$('[data-delete-schema]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-delete-schema');
        const nextSchema = state.schema.filter(f => f.key !== key);
        state.schema = await engine.saveSchema(nextSchema, state.primaryResource);
        toast('Champ retiré du studio');
        renderWorkspace();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
