/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * APPLICATION PRINCIPALE — IGEO ADMIN STUDIO (admin.igeopilot.com)
 * ═══════════════════════════════════════════════════════════════════════════════
 * - 6 vues :
 *     1. Véhicules (Matrice + Héritage Groupe + Swap IMEI + Champs Client/Date/Technicien)
 *     2. Groupes (Héritage des permissions en 1 clic)
 *     3. Utilisateurs & Rôles (Gestion du Type d'utilisateur : Technicien, Support, Client)
 *     4. Commandes par Rôle (Matrice Voir / Modifier / Lancer par rôle et par utilisateur)
 *     5. Comptes & Ressources CMS (Gestion des champs aflds/flds des comptes et ressources)
 *     6. Studio & Comportement des Champs (Création, modification de comportement, anti-doublon)
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
    activeTab: 'unit', // 'unit' | 'group' | 'user' | 'commands' | 'resource' | 'studio'
    search: '',
    quickFilter: 'all', // 'all' | 'missing_req' | 'ecodrive' | 'carburant'
    clientFilter: '',
    roleFilter: '', // '' | 'Technicien' | 'Support' | 'Client'
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
    commands: [],
    commandPolicies: {},
    schema: engine.DEFAULT_SCHEMA.slice(),
    selectedIds: new Set(),
    drawer: null, // { entityType, entityId, focusSwap: boolean }
    editingSchemaKey: null,
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
        const undoInfo = engine.peekUndo();
        userSlot.innerHTML = `
          ${undoInfo ? `
            <button type="button" class="adm-btn warn" id="adm-undo-btn" title="Annuler la dernière modification : ${esc(undoInfo.label)}">
              <span class="ms">undo</span> Annuler (${esc(undoInfo.label)})
            </button>
          ` : ''}
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

        const undoBtn = $('#adm-undo-btn');
        if (undoBtn) {
          undoBtn.addEventListener('click', async () => {
            undoBtn.disabled = true;
            try {
              const undone = await engine.undoLastAction();
              if (undone) {
                toast(`Modification annulée : ${undone.label}`);
                renderWorkspace();
              }
            } catch (e) {
              toast(e.message || 'Erreur lors de l’annulation', 'error');
              undoBtn.disabled = false;
            }
          });
        }
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
          <p>Gérez les permissions (Éco-conduite, Carburant), les rôles utilisateurs (Technicien, Support, Client), les droits sur les commandes (Voir / Modifier / Lancer) et les comptes CMS.</p>
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
      renderLoading('Lecture des véhicules, groupes, utilisateurs, commandes et comptes CMS Wialon…');
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
      state.commands = data.commands;
      state.commandPolicies = data.commandPolicies;
      state.schema = data.schema;
      renderWorkspace();
      if (showNotification) toast('Données, commandes et comptes CMS synchronisés avec Wialon');
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
    if (state.activeTab === 'resource') return state.resources;
    return state.units;
  }

  function findEntity(entityType, entityId) {
    const id = Number(entityId);
    if (entityType === 'group') return state.groups.find(g => g.id === id);
    if (entityType === 'user') return state.users.find(u => u.id === id);
    if (entityType === 'resource') return state.resources.find(r => r.id === id);
    return state.units.find(u => u.id === id);
  }

  function currentFieldsForTab(tab = state.activeTab, matrixOnly = false) {
    return state.schema.filter(f => {
      if (!Array.isArray(f.targets) || !f.targets.includes(tab)) return false;
      if (matrixOnly && f.visibleInMatrix === false) return false;
      return true;
    });
  }

  function filteredEntities() {
    const list = currentEntities();
    const q = state.search.trim().toLowerCase();
    const clientField = state.schema.find(f => f.key === 'client');

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

      if (state.activeTab === 'unit' && state.clientFilter && clientField) {
        const cVal = engine.getFieldRawValue(ent, clientField);
        if (cVal !== state.clientFilter) return false;
      }

      if ((state.activeTab === 'user' || state.activeTab === 'commands') && state.roleFilter) {
        const uRole = engine.getUserRole(ent);
        if (uRole !== state.roleFilter) return false;
      }

      if (!q) return true;
      const inName = (ent.name || '').toLowerCase().includes(q);
      const inImei = (ent.imei || '').toLowerCase().includes(q);
      const inGroups = Array.isArray(ent.groupNames) && ent.groupNames.some(gn => gn.toLowerCase().includes(q));
      const inCustomFields = state.schema.some(f => {
        const v = engine.getFieldRawValue(ent, f);
        return v && v.toLowerCase().includes(q);
      });
      return inName || inImei || inGroups || inCustomFields;
    });
  }

  function renderDatalistsHtml() {
    return state.schema
      .filter(f => f.type === 'text' && Array.isArray(f.discoveredValues) && f.discoveredValues.length > 0)
      .map(f => `
        <datalist id="adm-dl-${esc(f.key)}">
          ${f.discoveredValues.map(v => `<option value="${esc(v)}"></option>`).join('')}
        </datalist>
      `).join('');
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
      ${renderDatalistsHtml()}
      <div class="adm-workspace">
        <!-- Bandeau KPI cliquables -->
        <div class="adm-kpi-strip">
          <div class="adm-kpi-card ${state.activeTab === 'unit' && state.quickFilter === 'all' ? 'active-filter' : ''}" data-kpi-filter="all">
            <div class="adm-kpi-icon" style="background:rgba(35,131,226,0.12);color:#2383e2;"><span class="ms">directions_car</span></div>
            <div>
              <div class="adm-kpi-val">${state.units.length}</div>
              <div class="adm-kpi-lbl">Véhicules (${state.groups.length} groupes)</div>
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
              <div class="adm-kpi-lbl">Champs obligatoires incomplets</div>
            </div>
          </div>
        </div>

        <!-- Navigation par Onglets -->
        <div class="adm-nav-row">
          <div class="adm-tabs" style="flex-wrap:wrap;">
            <button type="button" class="adm-tab ${state.activeTab === 'unit' ? 'active' : ''}" data-tab="unit">
              <span class="ms">directions_car</span> Véhicules <span class="count">${state.units.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'group' ? 'active' : ''}" data-tab="group">
              <span class="ms">folder</span> Groupes <span class="count">${state.groups.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'user' ? 'active' : ''}" data-tab="user">
              <span class="ms">badge</span> Utilisateurs & Rôles <span class="count">${state.users.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'commands' ? 'active' : ''}" data-tab="commands">
              <span class="ms">terminal</span> Commandes (Voir / Modifier / Lancer) <span class="count">${state.commands.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'resource' ? 'active' : ''}" data-tab="resource">
              <span class="ms">account_tree</span> Comptes & Ressources CMS <span class="count">${state.resources.length}</span>
            </button>
            <button type="button" class="adm-tab ${state.activeTab === 'studio' ? 'active' : ''}" data-tab="studio">
              <span class="ms">auto_fix_high</span> Studio Champs <span class="count">${state.schema.length}</span>
            </button>
          </div>

          <div style="display:flex;gap:8px;align-items:center;">
            <button type="button" class="adm-btn primary" id="adm-new-field-shortcut">
              <span class="ms">tune</span> Configurer / Créer un champ
            </button>
          </div>
        </div>

        <!-- Contenu principal -->
        <div id="adm-tab-content"></div>
      </div>

      <div id="adm-bulk-slot"></div>
      <div id="adm-drawer-slot"></div>
    `;

    $$('[data-kpi-filter]').forEach(card => {
      card.addEventListener('click', () => {
        const f = card.getAttribute('data-kpi-filter');
        state.activeTab = 'unit';
        state.quickFilter = (state.quickFilter === f && f !== 'all') ? 'all' : f;
        state.selectedIds.clear();
        renderWorkspace();
      });
    });

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
      state.editingSchemaKey = null;
      renderWorkspace();
      const input = $('#studio-label');
      if (input) input.focus();
    });

    if (state.activeTab === 'studio') {
      renderStudioView();
    } else if (state.activeTab === 'commands') {
      renderCommandsMatrixView();
    } else {
      renderMatrixView();
    }

    renderBulkBar();
    renderDrawer();
  }

  // ── VUE SPÉCIALE : MATRICE DES COMMANDES (VOIR / MODIFIER / LANCER PAR RÔLE & UTILISATEUR) ──
  function renderCommandsMatrixView() {
    const slot = $('#adm-tab-content');
    if (!slot) return;

    const roles = engine.USER_ROLES; // ['Technicien', 'Support', 'Client']
    const q = state.search.trim().toLowerCase();
    const visibleUsers = state.users.filter(u => {
      if (state.roleFilter && engine.getUserRole(u) !== state.roleFilter) return false;
      if (!q) return true;
      return (u.name || '').toLowerCase().includes(q);
    });

    slot.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;">
        <!-- Bloc 1 : Politique des Commandes par Type d'utilisateur (Technicien, Support, Client) -->
        <div class="adm-studio-card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <div>
              <h3>
                <span class="ms" style="color:var(--primary);">shield_person</span>
                Droits sur les Commandes selon le Type d’utilisateur (Technicien · Support · Client)
              </h3>
              <div style="font-size:12px;color:var(--text-muted);margin-top:3px;">
                Définissez pour chaque profil ce qu'il peut <strong>Voir</strong>, <strong>Modifier</strong> et <strong>Lancer</strong>. Tout utilisateur affecté à un profil hérite automatiquement de ces droits.
              </div>
            </div>
          </div>

          <div class="adm-matrix-scroll">
            <table class="adm-matrix">
              <thead>
                <tr>
                  <th>Commande Wialon / Famille</th>
                  <th>Catégorie</th>
                  ${roles.map(role => `
                    <th>
                      <span class="adm-role-badge ${esc(role)}">
                        <span class="ms" style="font-size:14px;">badge</span> ${esc(role)}
                      </span>
                      <span style="margin-left:6px;font-weight:500;font-size:11px;color:var(--text-soft);">
                        (${state.users.filter(u => engine.getUserRole(u) === role).length} util.)
                      </span>
                    </th>
                  `).join('')}
                </tr>
              </thead>
              <tbody>
                ${state.commands.map(cmd => `
                  <tr class="adm-row">
                    <td>
                      <div style="display:flex;align-items:center;gap:9px;">
                        <span class="ms" style="color:${esc(cmd.color || 'var(--primary)')};font-size:20px;">${esc(cmd.icon || 'terminal')}</span>
                        <div>
                          <div style="font-weight:600;">${esc(cmd.name)}</div>
                          <div style="font-size:11px;color:var(--text-soft);">${esc(cmd.description || '')}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="adm-imei-badge">${esc(cmd.category || 'Standard')}</span>
                      ${cmd.unitCount ? `<span style="font-size:11px;color:var(--text-soft);margin-left:6px;">(${cmd.unitCount} véh.)</span>` : ''}
                    </td>
                    ${roles.map(role => {
                      const pol = (state.commandPolicies[role] && state.commandPolicies[role][cmd.key]) || { view: false, edit: false, exec: false };
                      return `
                        <td>
                          <div class="adm-cmd-trio">
                            <button type="button" class="adm-cmd-pill view ${pol.view ? 'active' : ''}" data-role-cmd="${esc(role)}:${esc(cmd.key)}:view" title="${esc(role)} : Voir la commande « ${esc(cmd.name)} »">
                              <span class="ms" style="font-size:14px;">visibility</span> Voir
                            </button>
                            <button type="button" class="adm-cmd-pill edit ${pol.edit ? 'active' : ''}" data-role-cmd="${esc(role)}:${esc(cmd.key)}:edit" title="${esc(role)} : Modifier la commande « ${esc(cmd.name)} »">
                              <span class="ms" style="font-size:14px;">edit</span> Modifier
                            </button>
                            <button type="button" class="adm-cmd-pill exec ${pol.exec ? 'active' : ''}" data-role-cmd="${esc(role)}:${esc(cmd.key)}:exec" title="${esc(role)} : Lancer la commande « ${esc(cmd.name)} »">
                              <span class="ms" style="font-size:14px;">play_arrow</span> Lancer
                            </button>
                          </div>
                        </td>
                      `;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Bloc 2 : Application & Surcharge par Utilisateur individuel -->
        <div class="adm-studio-card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <div>
              <h3>
                <span class="ms" style="color:var(--primary);">manage_accounts</span>
                Affectation du Type d’utilisateur & Droits de commandes par Utilisateur (${visibleUsers.length})
              </h3>
              <div style="font-size:12px;color:var(--text-muted);margin-top:3px;">
                Changez le type d’un utilisateur (<strong>Technicien</strong>, <strong>Support</strong>, <strong>Client</strong>) pour appliquer les droits du rôle, ou cliquez sur une pastille pour créer une exception individuelle.
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <input type="search" class="adm-input" id="adm-cmd-user-search" placeholder="Rechercher un utilisateur…" value="${esc(state.search)}">
              <button type="button" class="adm-filter-pill ${state.roleFilter === '' ? 'active' : ''}" data-rfilter="">Tous</button>
              ${roles.map(r => `
                <button type="button" class="adm-filter-pill ${state.roleFilter === r ? 'active' : ''}" data-rfilter="${esc(r)}">${esc(r)}</button>
              `).join('')}
            </div>
          </div>

          <div class="adm-matrix-scroll">
            <table class="adm-matrix">
              <thead>
                <tr>
                  <th>Utilisateur Wialon</th>
                  <th>Type d’utilisateur (Rôle)</th>
                  ${state.commands.map(cmd => `
                    <th>
                      <div style="display:inline-flex;align-items:center;gap:4px;">
                        <span class="ms" style="font-size:15px;color:${esc(cmd.color || 'var(--primary)')}">${esc(cmd.icon || 'terminal')}</span>
                        <span>${esc(cmd.name)}</span>
                      </div>
                    </th>
                  `).join('')}
                </tr>
              </thead>
              <tbody>
                ${visibleUsers.length === 0 ? `
                  <tr><td colspan="${state.commands.length + 2}" class="adm-empty">Aucun utilisateur trouvé.</td></tr>
                ` : visibleUsers.map(u => {
                  const uRole = engine.getUserRole(u);
                  return `
                    <tr class="adm-row">
                      <td>
                        <div class="adm-entity-title" data-open-drawer="user:${u.id}">${esc(u.name)}</div>
                        <div class="adm-entity-sub">ID #${u.id}</div>
                      </td>
                      <td>
                        <select class="adm-inline-input ${!uRole ? 'missing-req' : ''}" data-user-role-select="${u.id}">
                          <option value="">— Choisir rôle —</option>
                          ${roles.map(r => `<option value="${esc(r)}" ${uRole === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
                        </select>
                      </td>
                      ${state.commands.map(cmd => {
                        const acc = engine.evaluateUserCommandAccess(u, cmd.key, state.commandPolicies);
                        return `
                          <td>
                            <div style="display:inline-flex;align-items:center;gap:5px;">
                              <div class="adm-cmd-trio">
                                <button type="button" class="adm-cmd-pill view ${acc.view ? 'active' : ''}" data-user-cmd="${u.id}:${esc(cmd.key)}:view" title="Voir">
                                  <span class="ms" style="font-size:13px;">visibility</span> V
                                </button>
                                <button type="button" class="adm-cmd-pill edit ${acc.edit ? 'active' : ''}" data-user-cmd="${u.id}:${esc(cmd.key)}:edit" title="Modifier">
                                  <span class="ms" style="font-size:13px;">edit</span> M
                                </button>
                                <button type="button" class="adm-cmd-pill exec ${acc.exec ? 'active' : ''}" data-user-cmd="${u.id}:${esc(cmd.key)}:exec" title="Lancer">
                                  <span class="ms" style="font-size:13px;">play_arrow</span> L
                                </button>
                              </div>
                              ${!acc.inherited ? `
                                <button type="button" class="adm-reset-inherit" data-reset-user-cmd="${u.id}:${esc(cmd.key)}" title="Exception personnalisée — cliquer pour revenir au rôle ${esc(acc.role)}">
                                  <span class="ms" style="font-size:14px;">restart_alt</span>
                                </button>
                              ` : ''}
                            </div>
                          </td>
                        `;
                      }).join('')}
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Toggle Role Command Policy (Voir / Modifier / Lancer)
    $$('[data-role-cmd]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [role, cmdKey, right] = btn.getAttribute('data-role-cmd').split(':');
        if (!state.commandPolicies[role]) state.commandPolicies[role] = {};
        const curr = state.commandPolicies[role][cmdKey] || { view: false, edit: false, exec: false };
        const next = { ...curr, [right]: !curr[right] };
        // Si on active Modifier ou Lancer, activer automatiquement Voir
        if ((right === 'edit' || right === 'exec') && next[right]) {
          next.view = true;
        }
        // Si on désactive Voir, désactiver Modifier et Lancer
        if (right === 'view' && !next.view) {
          next.edit = false;
          next.exec = false;
        }
        state.commandPolicies[role][cmdKey] = next;
        try {
          await engine.saveCommandPolicies(state.commandPolicies, state.primaryResource);
          toast(`Profil ${role} mis à jour`);
          renderCommandsMatrixView();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Changement du rôle d'un utilisateur
    $$('[data-user-role-select]', slot).forEach(sel => {
      sel.addEventListener('change', async () => {
        const uId = Number(sel.getAttribute('data-user-role-select'));
        const userEnt = state.users.find(u => u.id === uId);
        const roleField = state.schema.find(f => f.key === 'role_utilisateur');
        if (!userEnt || !roleField) return;
        try {
          await engine.updateFieldOnEntities([userEnt], roleField, sel.value);
          toast(`${userEnt.name} → Rôle : ${sel.value || 'Non défini'}`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Surcharge individuelle d'une commande sur un utilisateur
    $$('[data-user-cmd]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [uIdStr, cmdKey, right] = btn.getAttribute('data-user-cmd').split(':');
        const userEnt = state.users.find(u => u.id === Number(uIdStr));
        if (!userEnt) return;
        const curr = engine.evaluateUserCommandAccess(userEnt, cmdKey, state.commandPolicies);
        const next = { view: curr.view, edit: curr.edit, exec: curr.exec, [right]: !curr[right] };
        if ((right === 'edit' || right === 'exec') && next[right]) next.view = true;
        if (right === 'view' && !next.view) { next.edit = false; next.exec = false; }
        try {
          await engine.updateUserCommandOverride(userEnt, cmdKey, next, state.commands, state.commandPolicies);
          toast(`Droits de commande personnalisés pour ${userEnt.name}`);
          renderCommandsMatrixView();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Reset d'une surcharge de commande utilisateur vers l'héritage de son rôle
    $$('[data-reset-user-cmd]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [uIdStr, cmdKey] = btn.getAttribute('data-reset-user-cmd').split(':');
        const userEnt = state.users.find(u => u.id === Number(uIdStr));
        if (!userEnt) return;
        try {
          await engine.updateUserCommandOverride(userEnt, cmdKey, null, state.commands, state.commandPolicies);
          toast(`${userEnt.name} : commande réinitialisée au rôle ${engine.getUserRole(userEnt) || 'Client'}`);
          renderCommandsMatrixView();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Filtres utilisateurs dans la vue commandes
    const uSearch = $('#adm-cmd-user-search');
    if (uSearch) {
      uSearch.addEventListener('input', (e) => {
        state.search = e.target.value;
        renderCommandsMatrixView();
      });
    }

    $$('[data-rfilter]', slot).forEach(btn => {
      btn.addEventListener('click', () => {
        state.roleFilter = btn.getAttribute('data-rfilter');
        renderCommandsMatrixView();
      });
    });

    $$('[data-open-drawer]', slot).forEach(btn => {
      btn.addEventListener('click', () => {
        const [eType, eIdStr] = btn.getAttribute('data-open-drawer').split(':');
        state.drawer = { entityType: eType, entityId: Number(eIdStr), focusSwap: false };
        renderDrawer();
      });
    });
  }

  // ── VUE 1 : MATRICE INTERACTIVE (Véhicules, Groupes, Utilisateurs, Comptes CMS) ──
  function renderMatrixView() {
    const slot = $('#adm-tab-content');
    if (!slot) return;

    const fields = currentFieldsForTab(state.activeTab, true);
    const entities = filteredEntities();
    const allVisibleSelected = entities.length > 0 && entities.every(e => state.selectedIds.has(e.id));
    const clientField = state.schema.find(f => f.key === 'client');
    const clientValues = (clientField && Array.isArray(clientField.discoveredValues)) ? clientField.discoveredValues : [];

    const entityColumnTitle = state.activeTab === 'unit'
      ? 'Véhicule & Boîtier'
      : state.activeTab === 'group'
        ? 'Groupe de véhicules'
        : state.activeTab === 'resource'
          ? 'Compte / Ressource CMS'
          : 'Utilisateur Wialon';

    slot.innerHTML = `
      <div class="adm-toolbar">
        <div class="adm-search-box">
          <span class="ms">search</span>
          <input type="search" class="adm-input" id="adm-search-input" placeholder="Rechercher par nom, client, technicien, IMEI, rôle ou compte…" value="${esc(state.search)}">
        </div>

        ${state.activeTab === 'unit' && clientValues.length > 0 ? `
          <select class="adm-select" id="adm-client-filter" title="Filtrer par Client">
            <option value="">Tous les clients (${clientValues.length})</option>
            ${clientValues.map(c => `<option value="${esc(c)}" ${state.clientFilter === c ? 'selected' : ''}>Client : ${esc(c)}</option>`).join('')}
          </select>
        ` : ''}

        ${state.activeTab === 'user' ? `
          <button type="button" class="adm-filter-pill ${state.roleFilter === '' ? 'active' : ''}" data-role-pill="">Tous les rôles</button>
          ${engine.USER_ROLES.map(r => `
            <button type="button" class="adm-filter-pill ${state.roleFilter === r ? 'active' : ''}" data-role-pill="${esc(r)}">${esc(r)}</button>
          `).join('')}
        ` : ''}

        <button type="button" class="adm-filter-pill ${state.quickFilter === 'all' ? 'active' : ''}" data-qfilter="all">
          Tous (${currentEntities().length})
        </button>
        <button type="button" class="adm-filter-pill warn ${state.quickFilter === 'missing_req' ? 'active' : ''}" data-qfilter="missing_req">
          <span class="ms" style="font-size:15px;">warning</span> Obligatoires manquants
        </button>
        ${state.activeTab === 'unit' || state.activeTab === 'group' ? `
          <button type="button" class="adm-filter-pill ${state.quickFilter === 'ecodrive' ? 'active' : ''}" data-qfilter="ecodrive">
            <span class="ms" style="font-size:15px;color:#16a34a;">eco</span> Éco-conduite
          </button>
          <button type="button" class="adm-filter-pill ${state.quickFilter === 'carburant' ? 'active' : ''}" data-qfilter="carburant">
            <span class="ms" style="font-size:15px;color:#2563eb;">local_gas_station</span> Carburant
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
                <th>${entityColumnTitle}</th>
                <th>Conformité</th>
                ${fields.map(f => `
                  <th>
                    <div style="display:inline-flex;align-items:center;gap:5px;">
                      <span class="ms" style="font-size:15px;color:${esc(f.color || 'var(--primary)')}">${esc(f.icon || 'tune')}</span>
                      <span>${esc(f.label)}</span>
                      ${f.required ? '<span class="adm-req-star" title="Champ obligatoire">*</span>' : ''}
                      <button type="button" class="adm-reset-inherit" data-edit-field-behavior="${esc(f.key)}" title="Modifier le comportement du champ « ${esc(f.label)} »">
                        <span class="ms" style="font-size:13px;">settings</span>
                      </button>
                    </div>
                  </th>
                `).join('')}
                ${state.activeTab === 'user' ? `<th>Commandes (Voir / Modifier / Lancer)</th>` : ''}
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

    const searchInput = $('#adm-search-input');
    searchInput.addEventListener('input', (e) => {
      state.search = e.target.value;
      $('#adm-matrix-tbody').innerHTML = renderMatrixRowsHtml(filteredEntities(), fields);
      bindMatrixRowEvents();
    });

    const clientSel = $('#adm-client-filter');
    if (clientSel) {
      clientSel.addEventListener('change', (e) => {
        state.clientFilter = e.target.value;
        renderMatrixView();
      });
    }

    $$('[data-role-pill]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.roleFilter = btn.getAttribute('data-role-pill');
        renderMatrixView();
      });
    });

    $$('[data-qfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.quickFilter = btn.getAttribute('data-qfilter');
        renderWorkspace();
      });
    });

    $$('[data-edit-field-behavior]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.editingSchemaKey = btn.getAttribute('data-edit-field-behavior');
        state.activeTab = 'studio';
        renderWorkspace();
      });
    });

    const grpBtn = $('#adm-toggle-grouping');
    if (grpBtn) {
      grpBtn.addEventListener('click', () => {
        state.groupByGroup = !state.groupByGroup;
        renderMatrixView();
      });
    }

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
    const colCount = fields.length + (state.activeTab === 'user' ? 5 : 4);
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
                <span style="font-size:11.5px;color:var(--text-muted);">Héritage groupe :</span>
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
    } else if (ent.entityType === 'resource') {
      const afCount = Object.keys((ent.raw && ent.raw.aflds) || {}).length;
      const fCount = Object.keys((ent.raw && ent.raw.flds) || {}).length;
      subLine = `
        <span class="adm-imei-badge">Compte #${ent.accountId || ent.id}</span>
        <span>${afCount} champ(s) admin · ${fCount} champ(s) perso</span>
      `;
    } else {
      const uRole = engine.getUserRole(ent);
      subLine = `
        <span>ID Wialon #${ent.id}</span>
        ${uRole ? `<span class="adm-role-badge ${esc(uRole)}">${esc(uRole)}</span>` : ''}
      `;
    }

    let userCmdSummaryTd = '';
    if (ent.entityType === 'user') {
      const execCount = state.commands.filter(c => engine.evaluateUserCommandAccess(ent, c.key, state.commandPolicies).exec).length;
      const viewCount = state.commands.filter(c => engine.evaluateUserCommandAccess(ent, c.key, state.commandPolicies).view).length;
      userCmdSummaryTd = `
        <td>
          <button type="button" class="adm-btn sm" data-open-drawer="user:${ent.id}" title="Configurer les commandes Voir / Modifier / Lancer pour ${esc(ent.name)}">
            <span class="ms" style="font-size:15px;color:var(--primary);">terminal</span>
            Voir: ${viewCount}/${state.commands.length} · Lancer: ${execCount}/${state.commands.length}
          </button>
        </td>
      `;
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
                <span class="ms" style="font-size:13px;">warning</span> ${missing.map(m => esc(m.label)).join(', ')}
              </span>`
          }
        </td>
        ${fields.map(f => `<td>${renderMatrixCellControlHtml(ent, f)}</td>`).join('')}
        ${userCmdSummaryTd}
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
      const opts = Array.isArray(fieldDef.options) && fieldDef.options.length
        ? fieldDef.options
        : (fieldDef.discoveredValues || []);
      const allOpts = rawVal && !opts.includes(rawVal) ? [rawVal, ...opts] : opts;
      return `
        <select class="adm-inline-input ${isMissingReq ? 'missing-req' : ''}"
          data-inline-field="${ent.entityType}:${ent.id}:${fieldDef.key}">
          <option value="">— Choisir —</option>
          ${allOpts.map(opt => `<option value="${esc(opt)}" ${rawVal === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        </select>
      `;
    }

    const hasDatalist = fieldDef.type === 'text' && Array.isArray(fieldDef.discoveredValues) && fieldDef.discoveredValues.length > 0;
    return `
      <input type="${fieldDef.type === 'number' ? 'number' : 'text'}"
        class="adm-inline-input ${isMissingReq ? 'missing-req' : ''}"
        value="${esc(rawVal)}"
        ${hasDatalist ? `list="adm-dl-${esc(fieldDef.key)}"` : ''}
        placeholder="${fieldDef.required ? 'Obligatoire…' : '—'}"
        data-inline-field="${ent.entityType}:${ent.id}:${fieldDef.key}">
    `;
  }

  function bindMatrixRowEvents() {
    const tbody = $('#adm-matrix-tbody');
    if (!tbody) return;

    $$('.adm-row-check', tbody).forEach(chk => {
      chk.addEventListener('change', () => {
        const id = Number(chk.getAttribute('data-check-id'));
        if (chk.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        renderBulkBar();
      });
    });

    $$('[data-toggle-group]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const gKey = btn.getAttribute('data-toggle-group');
        if (state.collapsedGroups.has(gKey)) state.collapsedGroups.delete(gKey);
        else state.collapsedGroups.add(gKey);
        renderMatrixView();
      });
    });

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

    $$('[data-inline-field]', tbody).forEach(input => {
      input.addEventListener('change', async () => {
        const [eType, eIdStr, fKey] = input.getAttribute('data-inline-field').split(':');
        const ent = findEntity(eType, eIdStr);
        const fieldDef = state.schema.find(f => f.key === fKey);
        if (!ent || !fieldDef) return;
        const val = input.value.trim();
        try {
          await engine.updateFieldOnEntities([ent], fieldDef, val);
          if (val && Array.isArray(fieldDef.discoveredValues) && !fieldDef.discoveredValues.includes(val)) {
            fieldDef.discoveredValues.push(val);
          }
          toast(`${ent.name} · ${fieldDef.label} enregistré`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
          input.value = engine.getFieldRawValue(ent, fieldDef);
        }
      });
    });

    $$('[data-open-drawer]', tbody).forEach(btn => {
      btn.addEventListener('click', () => {
        const [eType, eIdStr] = btn.getAttribute('data-open-drawer').split(':');
        state.drawer = { entityType: eType, entityId: Number(eIdStr), focusSwap: false };
        renderDrawer();
      });
    });

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
    if (!state.selectedIds.size || state.activeTab === 'studio' || state.activeTab === 'commands') {
      slot.innerHTML = '';
      return;
    }

    const fields = currentFieldsForTab(state.activeTab, false);
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
        const opts = (activeField.options && activeField.options.length) ? activeField.options : (activeField.discoveredValues || []);
        valueControlHtml = `
          <select class="adm-select" id="adm-bulk-val">
            <option value="">— Choisir —</option>
            ${opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select>`;
      } else {
        const hasDl = activeField.type === 'text' && Array.isArray(activeField.discoveredValues) && activeField.discoveredValues.length > 0;
        valueControlHtml = `<input type="${activeField.type === 'number' ? 'number' : 'text'}" class="adm-input" id="adm-bulk-val" ${hasDl ? `list="adm-dl-${esc(activeField.key)}"` : ''} placeholder="Nouvelle valeur…">`;
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

  // ── VUE 2 : TIROIR LATÉRAL DÉTAILLÉ (Véhicule, Groupe, Utilisateur, Compte CMS) ──
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

    const fields = currentFieldsForTab(ent.entityType, false);
    const permFields = fields.filter(f => f.type === 'boolean');
    const dataFields = fields.filter(f => f.type !== 'boolean');
    const swapHistory = ent.entityType === 'unit' ? engine.getUnitSwapHistory(ent) : [];
    const todayIso = new Date().toISOString().slice(0, 10);

    const rawAflds = Object.values((ent.raw && ent.raw.aflds) || {}).filter(x => x && x.n && !x.n.startsWith('_igeo_'));
    const rawFlds = Object.values((ent.raw && ent.raw.flds) || {}).filter(x => x && x.n && !x.n.startsWith('_igeo_'));

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
                    : ent.entityType === 'resource'
                      ? `Compte / Ressource CMS #${ent.id}`
                      : `Utilisateur Wialon #${ent.id} · Rôle : <strong>${esc(engine.getUserRole(ent) || 'Non défini')}</strong>`}
              </div>
            </div>
            <button type="button" class="adm-btn ghost" id="adm-drawer-close"><span class="ms">close</span></button>
          </div>

          <div class="adm-drawer-body">
            <!-- Section Permissions -->
            ${permFields.length ? `
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
            ` : ''}

            <!-- Section Commandes (Voir / Modifier / Lancer) pour les Utilisateurs -->
            ${ent.entityType === 'user' ? `
              <div class="adm-section">
                <div class="adm-section-title">
                  <span class="ms" style="color:var(--primary);">terminal</span>
                  Commandes autorisées (Voir · Modifier · Lancer)
                </div>
                <div style="font-size:11.5px;color:var(--text-muted);">
                  Droits hérités du type d’utilisateur <strong>${esc(engine.getUserRole(ent) || 'Client (par défaut)')}</strong>. Cliquez sur Voir, Modifier ou Lancer pour personnaliser cet utilisateur.
                </div>
                ${state.commands.map(cmd => {
                  const acc = engine.evaluateUserCommandAccess(ent, cmd.key, state.commandPolicies);
                  return `
                    <div class="adm-perm-card">
                      <div class="adm-perm-card-info">
                        <span class="ms" style="color:${esc(cmd.color || 'var(--primary)')};font-size:20px;">${esc(cmd.icon || 'terminal')}</span>
                        <div>
                          <div style="font-weight:600;">${esc(cmd.name)}</div>
                          <div style="font-size:11px;color:var(--text-muted);">
                            ${acc.inherited ? `Hérité du rôle ${esc(acc.role)}` : 'Exception personnalisée sur cet utilisateur'}
                          </div>
                        </div>
                      </div>
                      <div style="display:inline-flex;align-items:center;gap:6px;">
                        <div class="adm-cmd-trio">
                          <button type="button" class="adm-cmd-pill view ${acc.view ? 'active' : ''}" data-drawer-ucmd="${esc(cmd.key)}:view">
                            <span class="ms" style="font-size:13px;">visibility</span> Voir
                          </button>
                          <button type="button" class="adm-cmd-pill edit ${acc.edit ? 'active' : ''}" data-drawer-ucmd="${esc(cmd.key)}:edit">
                            <span class="ms" style="font-size:13px;">edit</span> Modifier
                          </button>
                          <button type="button" class="adm-cmd-pill exec ${acc.exec ? 'active' : ''}" data-drawer-ucmd="${esc(cmd.key)}:exec">
                            <span class="ms" style="font-size:13px;">play_arrow</span> Lancer
                          </button>
                        </div>
                        ${!acc.inherited ? `
                          <button type="button" class="adm-reset-inherit" data-drawer-reset-ucmd="${esc(cmd.key)}" title="Revenir aux droits du rôle">
                            <span class="ms" style="font-size:15px;">restart_alt</span>
                          </button>
                        ` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}

            <!-- Section Champs métiers & Obligatoires -->
            ${dataFields.length ? `
              <div class="adm-section">
                <div class="adm-section-title">
                  <span class="ms" style="color:var(--warn);">fact_check</span>
                  Champs métiers & Obligatoires (${dataFields.length})
                </div>
                <div class="adm-form-grid">
                  ${dataFields.map(f => {
                    const val = engine.getFieldRawValue(ent, f);
                    const missing = f.required && !val;
                    const opts = Array.isArray(f.options) && f.options.length ? f.options : (f.discoveredValues || []);
                    const allOpts = val && !opts.includes(val) ? [val, ...opts] : opts;
                    const hasDl = f.type === 'text' && Array.isArray(f.discoveredValues) && f.discoveredValues.length > 0;
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
                            ${allOpts.map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
                          </select>
                        ` : `
                          <input type="${f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}"
                            class="adm-input ${missing ? 'missing-req' : ''}"
                            value="${esc(val)}"
                            ${hasDl ? `list="adm-dl-${esc(f.key)}"` : ''}
                            data-drawer-field="${f.key}"
                            placeholder="${f.required ? 'Champ obligatoire…' : '—'}">
                        `}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            ` : ''}

            <!-- Section Assistant de Remplacement d'IMEI (Swap de Boîtier) pour les véhicules -->
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

            <!-- Section Vue brute + Ajout libre d'un champ sur cette fiche -->
            <div class="adm-section">
              <div class="adm-section-title">
                <span class="ms">database</span>
                Champs Wialon bruts enregistrés sur cette fiche (${rawAflds.length + rawFlds.length})
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <input type="text" class="adm-input" id="adm-raw-add-name" placeholder="Nom du champ…" style="flex:1;min-width:130px;">
                <input type="text" class="adm-input" id="adm-raw-add-val" placeholder="Valeur…" style="flex:1;min-width:130px;">
                <select class="adm-select" id="adm-raw-add-storage">
                  <option value="aflds">Admin (aflds)</option>
                  <option value="flds">Perso (flds)</option>
                </select>
                <button type="button" class="adm-btn primary" id="adm-raw-add-btn">Enregistrer</button>
              </div>
              ${rawAflds.length === 0 && rawFlds.length === 0 ? `
                <div style="font-size:12px;color:var(--text-muted);">Aucun champ personnalisé/administratif brut sur cette fiche.</div>
              ` : `
                <div class="adm-history-list">
                  ${rawAflds.map(f => `
                    <div class="adm-history-item">
                      <div>
                        <span class="adm-imei-badge">Admin (aflds)</span>
                        <strong style="margin-left:6px;">${esc(f.n)}</strong>
                      </div>
                      <div style="display:flex;align-items:center;gap:8px;">
                        <span>${esc(f.v)}</span>
                        <button type="button" class="adm-reset-inherit" data-raw-del="aflds:${esc(f.n)}" title="Supprimer ce champ">
                          <span class="ms" style="font-size:15px;color:var(--danger);">delete</span>
                        </button>
                      </div>
                    </div>
                  `).join('')}
                  ${rawFlds.map(f => `
                    <div class="adm-history-item">
                      <div>
                        <span class="adm-imei-badge">Perso (flds)</span>
                        <strong style="margin-left:6px;">${esc(f.n)}</strong>
                      </div>
                      <div style="display:flex;align-items:center;gap:8px;">
                        <span>${esc(f.v)}</span>
                        <button type="button" class="adm-reset-inherit" data-raw-del="flds:${esc(f.n)}" title="Supprimer ce champ">
                          <span class="ms" style="font-size:15px;color:var(--danger);">delete</span>
                        </button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              `}
            </div>
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

    $$('[data-drawer-ucmd]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [cmdKey, right] = btn.getAttribute('data-drawer-ucmd').split(':');
        const curr = engine.evaluateUserCommandAccess(ent, cmdKey, state.commandPolicies);
        const next = { view: curr.view, edit: curr.edit, exec: curr.exec, [right]: !curr[right] };
        if ((right === 'edit' || right === 'exec') && next[right]) next.view = true;
        if (right === 'view' && !next.view) { next.edit = false; next.exec = false; }
        try {
          await engine.updateUserCommandOverride(ent, cmdKey, next, state.commands, state.commandPolicies);
          toast(`Commande mise à jour pour ${ent.name}`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    $$('[data-drawer-reset-ucmd]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const cmdKey = btn.getAttribute('data-drawer-reset-ucmd');
        try {
          await engine.updateUserCommandOverride(ent, cmdKey, null, state.commands, state.commandPolicies);
          toast('Droit de commande réinitialisé au rôle');
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

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

    // Ajout direct d'un champ brut sur la fiche
    const rawAddBtn = $('#adm-raw-add-btn');
    if (rawAddBtn) {
      rawAddBtn.addEventListener('click', async () => {
        const n = ($('#adm-raw-add-name').value || '').trim();
        const v = ($('#adm-raw-add-val').value || '').trim();
        const st = $('#adm-raw-add-storage').value || 'aflds';
        if (!n || !v) {
          toast('Renseignez le nom et la valeur du champ.', 'warn');
          return;
        }
        try {
          await engine.updateFieldOnEntities([ent], { key: n, canonicalName: n, label: n, type: 'text', storage: st }, v);
          toast(`Champ « ${n} » enregistré sur ${ent.name}`);
          await refreshWorkspaceData(false);
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }

    // Suppression d'un champ brut
    $$('[data-raw-del]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [st, name] = btn.getAttribute('data-raw-del').split(':');
        try {
          await engine.updateFieldOnEntities([ent], { key: name, canonicalName: name, label: name, type: 'text', storage: st }, '');
          toast(`Champ « ${name} » supprimé de ${ent.name}`);
          renderWorkspace();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

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

  // ── VUE 3 : STUDIO DE CONFIGURATION DU COMPORTEMENT DES CHAMPS & CRÉATION ───
  function renderStudioView() {
    const slot = $('#adm-tab-content');
    if (!slot) return;

    const editingField = state.editingSchemaKey
      ? state.schema.find(f => f.key === state.editingSchemaKey)
      : null;

    const edLabel = editingField ? editingField.label : '';
    const edCanonical = editingField ? (editingField.canonicalName || editingField.key) : '';
    const edType = editingField ? editingField.type : 'boolean';
    const edIcon = editingField ? (editingField.icon || 'verified') : 'verified';
    const edColor = editingField ? (editingField.color || '#2383e2') : '#2383e2';
    const edDesc = editingField ? (editingField.description || '') : '';
    const edReq = editingField ? !!editingField.required : false;
    const edMatrix = editingField ? (editingField.visibleInMatrix !== false) : true;
    const edStorage = editingField ? (editingField.storage || 'aflds') : 'aflds';
    const edTargets = editingField ? (editingField.targets || ['unit']) : ['unit'];
    const edOptions = editingField
      ? ((Array.isArray(editingField.options) && editingField.options.length)
          ? editingField.options.join(', ')
          : (editingField.discoveredValues || []).join(', '))
      : '';

    slot.innerHTML = `
      <div class="adm-studio-grid">
        <!-- Colonne gauche : Catalogue des champs détectés et configurés -->
        <div class="adm-studio-card">
          <h3>
            <span class="ms" style="color:var(--primary);">view_column</span>
            Champs Wialon détectés & Permissions (${state.schema.length})
          </h3>
          <div style="font-size:12px;color:var(--text-muted);">
            Tous les champs existants sur vos véhicules, groupes, utilisateurs et comptes CMS (<code>client</code>, <code>Date d'installation</code>, <code>technicien</code>, <code>role_utilisateur</code>…) sont automatiquement détectés. Cliquez sur <strong>Configurer</strong> pour modifier leur comportement.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${state.schema.map(f => {
              const hasVariants = (Array.isArray(f.discoveredNames) && f.discoveredNames.length > 1) || (f.duplicateUnitsCount > 0);
              const isEditing = state.editingSchemaKey === f.key;
              return `
                <div class="adm-schema-item" style="${isEditing ? 'border-color:var(--primary);background:var(--primary-soft);' : ''}">
                  <div style="display:flex;align-items:center;gap:12px;">
                    <div class="adm-kpi-icon" style="width:36px;height:36px;background:var(--bg-panel);color:${esc(f.color || 'var(--primary)')};border:1px solid var(--border);">
                      <span class="ms">${esc(f.icon || 'tune')}</span>
                    </div>
                    <div>
                      <div style="font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        ${esc(f.label)}
                        <code class="adm-imei-badge" title="Nom du champ dans Wialon">${esc(f.canonicalName || f.key)}</code>
                        ${f.required ? '<span class="adm-req-badge missing">Obligatoire</span>' : ''}
                        ${f.autoDiscovered ? '<span class="adm-perm-tag inherited">Détecté dans Wialon</span>' : ''}
                        ${hasVariants ? `<span class="adm-req-badge missing" title="Variantes détectées : ${esc((f.discoveredNames || []).join(' / '))}">Doublons/Variantes détectés</span>` : ''}
                      </div>
                      <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">
                        Type : <strong>${esc(f.type)}</strong>
                        · Cibles : <strong>${esc((f.targets || []).join(', '))}</strong>
                        · Renseigné sur <strong>${f.filledCount || 0}</strong> fiche(s)
                        ${Array.isArray(f.discoveredValues) && f.discoveredValues.length > 0
                          ? ` · <strong>${f.discoveredValues.length}</strong> valeur(s) distincte(s)`
                          : ''}
                      </div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                    ${hasVariants ? `
                      <button type="button" class="adm-btn sm warn" data-unify-field="${esc(f.key)}" title="Unifier toutes les variantes sous le nom « ${esc(f.canonicalName || f.key)} » et supprimer les doublons">
                        <span class="ms" style="font-size:14px;">cleaning_services</span> Unifier doublons
                      </button>
                    ` : ''}
                    <button type="button" class="adm-btn sm ${isEditing ? 'primary' : ''}" data-edit-schema="${esc(f.key)}">
                      <span class="ms" style="font-size:14px;">tune</span> Configurer
                    </button>
                    ${!f.system ? `
                      <button type="button" class="adm-btn sm danger" data-delete-schema="${esc(f.key)}" title="Masquer/Retirer ce champ du studio">
                        <span class="ms" style="font-size:15px;">delete</span>
                      </button>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Colonne droite : Éditeur de comportement ou Créateur de nouveau champ -->
        <div class="adm-studio-card">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <h3>
              <span class="ms" style="color:${editingField ? 'var(--primary)' : 'var(--success)'};">
                ${editingField ? 'tune' : 'add_circle'}
              </span>
              ${editingField ? `Modifier le comportement : « ${esc(editingField.label)} »` : 'Créer une Permission ou un Champ Typé'}
            </h3>
            ${editingField ? `
              <button type="button" class="adm-btn sm ghost" id="studio-cancel-edit">
                + Nouveau champ
              </button>
            ` : ''}
          </div>

          <div class="adm-form-grid">
            <div class="adm-field-group">
              <label>Nom affiché dans l'application <span class="adm-req-star">*</span></label>
              <input type="text" class="adm-input" id="studio-label" value="${esc(edLabel)}" placeholder="Ex: Client, Date d'installation, Technicien…">
            </div>
            <div class="adm-field-group">
              <label>Nom exact du champ dans Wialon <span class="adm-req-star">*</span></label>
              <input type="text" class="adm-input" id="studio-canonical" value="${esc(edCanonical)}" ${editingField && editingField.system ? 'readonly' : ''} placeholder="Ex: client, Date d'installation, technicien">
            </div>
          </div>

          <div class="adm-form-grid">
            <div class="adm-field-group">
              <label>Comportement & Type de donnée <span class="adm-req-star">*</span></label>
              <select class="adm-select" id="studio-type">
                <option value="text" ${edType === 'text' ? 'selected' : ''}>Texte avec auto-suggestion des valeurs existantes</option>
                <option value="select" ${edType === 'select' ? 'selected' : ''}>Liste déroulante stricte (empêche toute erreur de saisie)</option>
                <option value="date" ${edType === 'date' ? 'selected' : ''}>Date uniquement (Calendrier AAAA-MM-JJ)</option>
                <option value="number" ${edType === 'number' ? 'selected' : ''}>Nombre uniquement</option>
                <option value="boolean" ${edType === 'boolean' ? 'selected' : ''}>Permission Oui / Non (Switch 1-clic)</option>
              </select>
            </div>
            <div class="adm-field-group">
              <label>Emplacement dans Wialon</label>
              <select class="adm-select" id="studio-storage">
                <option value="aflds" ${edStorage === 'aflds' ? 'selected' : ''}>Champ Administratif (aflds - invisible client)</option>
                <option value="flds" ${edStorage === 'flds' ? 'selected' : ''}>Champ Personnalisé (flds - visible client)</option>
              </select>
            </div>
          </div>

          <div class="adm-field-group" id="studio-options-wrap" style="${edType === 'select' ? '' : 'display:none;'}">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <label>Valeurs autorisées dans la liste déroulante (séparées par une virgule) <span class="adm-req-star">*</span></label>
              ${editingField && Array.isArray(editingField.discoveredValues) && editingField.discoveredValues.length > 0 ? `
                <button type="button" class="adm-btn sm ghost" id="studio-fill-discovered" style="color:var(--primary);">
                  Importer les ${editingField.discoveredValues.length} valeurs actuelles du parc
                </button>
              ` : ''}
            </div>
            <input type="text" class="adm-input" id="studio-options" value="${esc(edOptions)}" placeholder="Ex: Technicien, Support, Client…">
          </div>

          ${editingField && Array.isArray(editingField.discoveredValues) && editingField.discoveredValues.length > 0 ? `
            <div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
              <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px;">
                Valeurs actuellement trouvées dans Wialon pour « ${esc(editingField.label)} » (${editingField.discoveredValues.length}) :
              </div>
              <div style="display:flex;gap:5px;flex-wrap:wrap;">
                ${editingField.discoveredValues.slice(0, 30).map(v => `<span class="adm-imei-badge">${esc(v)}</span>`).join('')}
              </div>
              ${edType !== 'select' ? `
                <button type="button" class="adm-btn sm" id="studio-convert-to-select" style="margin-top:8px;">
                  <span class="ms" style="font-size:15px;color:var(--primary);">lock</span>
                  Verrouiller en Liste déroulante stricte avec ces ${editingField.discoveredValues.length} valeurs
                </button>
              ` : ''}
            </div>
          ` : ''}

          <div class="adm-form-grid">
            <div class="adm-field-group">
              <label>Icône Material & Couleur</label>
              <div style="display:flex;gap:6px;">
                <input type="text" class="adm-input" id="studio-icon" value="${esc(edIcon)}" style="flex:1;" placeholder="Icône (ex: business, engineering, event)">
                <input type="color" class="adm-input" id="studio-color" value="${esc(edColor)}" style="width:46px;padding:2px;">
              </div>
            </div>
            <div class="adm-field-group">
              <label>Description / Consigne</label>
              <input type="text" class="adm-input" id="studio-desc" value="${esc(edDesc)}" placeholder="Ex: Nom du technicien installateur…">
            </div>
          </div>

          <div class="adm-field-group">
            <label>Entités cibles <span class="adm-req-star">*</span></label>
            <div style="display:flex;gap:14px;padding:6px 0;flex-wrap:wrap;">
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-unit" ${edTargets.includes('unit') ? 'checked' : ''}> Véhicules
              </label>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-group" ${edTargets.includes('group') ? 'checked' : ''}> Groupes (avec héritage)
              </label>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-user" ${edTargets.includes('user') ? 'checked' : ''}> Utilisateurs
              </label>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" id="studio-target-resource" ${edTargets.includes('resource') ? 'checked' : ''}> Comptes & Ressources CMS
              </label>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            <label style="display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:var(--text-main);">
              <input type="checkbox" id="studio-required" ${edReq ? 'checked' : ''}>
              <strong>Champ obligatoire</strong> (signale toute fiche où ce champ est manquant ou invalide)
            </label>
            <label style="display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:var(--text-main);">
              <input type="checkbox" id="studio-matrix-vis" ${edMatrix ? 'checked' : ''}>
              <strong>Afficher en colonne dans la Matrice principale</strong>
            </label>
          </div>

          <button type="button" class="adm-btn primary" id="studio-save-btn" style="height:38px;">
            <span class="ms">save</span>
            ${editingField ? `Enregistrer le comportement de « ${esc(editingField.label)} »` : 'Créer et synchroniser dans Wialon'}
          </button>
        </div>
      </div>
    `;

    const labelIn = $('#studio-label');
    const canonicalIn = $('#studio-canonical');
    const typeSel = $('#studio-type');
    const optsWrap = $('#studio-options-wrap');
    const optsIn = $('#studio-options');

    if (!editingField) {
      labelIn.addEventListener('input', () => {
        canonicalIn.value = labelIn.value.trim();
      });
    }

    typeSel.addEventListener('change', () => {
      optsWrap.style.display = typeSel.value === 'select' ? '' : 'none';
    });

    const cancelBtn = $('#studio-cancel-edit');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        state.editingSchemaKey = null;
        renderStudioView();
      });
    }

    const fillBtn = $('#studio-fill-discovered');
    if (fillBtn && editingField) {
      fillBtn.addEventListener('click', () => {
        optsIn.value = (editingField.discoveredValues || []).join(', ');
      });
    }

    const convertBtn = $('#studio-convert-to-select');
    if (convertBtn && editingField) {
      convertBtn.addEventListener('click', () => {
        typeSel.value = 'select';
        optsWrap.style.display = '';
        optsIn.value = (editingField.discoveredValues || []).join(', ');
      });
    }

    $('#studio-save-btn').addEventListener('click', async () => {
      const label = labelIn.value.trim();
      const canonicalName = canonicalIn.value.trim() || label;
      const key = editingField ? editingField.key : engine.normalizeKey(canonicalName);
      const type = typeSel.value;
      const storage = $('#studio-storage').value || 'aflds';
      const icon = ($('#studio-icon').value || 'tune').trim();
      const color = $('#studio-color').value || '#2383e2';
      const description = $('#studio-desc').value.trim();
      const required = $('#studio-required').checked;
      const visibleInMatrix = $('#studio-matrix-vis').checked;
      const options = (optsIn.value || '').split(',').map(s => s.trim()).filter(Boolean);

      const targets = [];
      if ($('#studio-target-unit').checked) targets.push('unit');
      if ($('#studio-target-group').checked) targets.push('group');
      if ($('#studio-target-user').checked) targets.push('user');
      if ($('#studio-target-resource').checked) targets.push('resource');

      if (!label || !key) {
        toast('Veuillez renseigner un nom pour le champ.', 'warn');
        return;
      }
      if (!targets.length) {
        toast('Sélectionnez au moins une cible (Véhicules, Groupes, Utilisateurs ou Comptes CMS).', 'warn');
        return;
      }
      if (type === 'select' && !options.length) {
        toast('Indiquez au moins une valeur autorisée pour la liste déroulante.', 'warn');
        return;
      }

      const updatedDef = {
        ...(editingField || {}),
        key,
        canonicalName,
        label,
        description,
        type,
        options: type === 'select' ? options : undefined,
        targets,
        required,
        visibleInMatrix,
        icon,
        color,
        storage,
        category: type === 'boolean' ? 'permission' : 'field'
      };

      const nextSchema = editingField
        ? state.schema.map(f => f.key === editingField.key ? updatedDef : f)
        : [...state.schema.filter(f => engine.canonicalToken(f.key) !== engine.canonicalToken(key)), updatedDef];

      state.schema = await engine.saveSchema(nextSchema, state.primaryResource, state.units, state.groups, state.users, state.resources);
      state.editingSchemaKey = null;
      toast(`Comportement du champ « ${label} » enregistré`);
      renderWorkspace();
    });

    $$('[data-edit-schema]', slot).forEach(btn => {
      btn.addEventListener('click', () => {
        state.editingSchemaKey = btn.getAttribute('data-edit-schema');
        renderStudioView();
      });
    });

    $$('[data-unify-field]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-unify-field');
        const fieldDef = state.schema.find(f => f.key === key);
        if (!fieldDef) return;
        btn.disabled = true;
        try {
          const allEnts = [...state.units, ...state.groups, ...state.users, ...state.resources];
          const res = await engine.unifyAndDeduplicateField(fieldDef, allEnts);
          toast(`${res.cleaned} fiche(s) nettoyée(s) et unifiée(s) sous « ${fieldDef.canonicalName || fieldDef.key} »`);
          await refreshWorkspaceData(false);
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      });
    });

    $$('[data-delete-schema]', slot).forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-delete-schema');
        const nextSchema = state.schema.filter(f => f.key !== key);
        state.schema = await engine.saveSchema(nextSchema, state.primaryResource, state.units, state.groups, state.users, state.resources);
        if (state.editingSchemaKey === key) state.editingSchemaKey = null;
        toast('Champ retiré du studio');
        renderWorkspace();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
