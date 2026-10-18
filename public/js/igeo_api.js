/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLIENT API IGEO (WIALON LOCAL) — admin.igeopilot.com
 * ═══════════════════════════════════════════════════════════════════════════════
 * Relais /wialon-api avec droits d'administration complets (access_type = -1)
 * pour la gestion des permissions, champs personnalisés/administratifs et boîtiers.
 */
(function () {
  const IGEO_HOST = 'https://track.igeo.africa';
  const API_URL = IGEO_HOST + '/wialon/ajax.html';
  const PROXY_URL = '/wialon-api';
  const TOKEN_RELAY_URL = IGEO_HOST + '/post_token.html';
  // -1 = Accès complet (lecture + écriture des champs administratifs, champs personnalisés, IMEI/matériel)
  const ACCESS_TYPE = -1;
  const TOKEN_DURATION_SEC = 86400;
  const STORAGE_KEY = 'igeo_admin_token';

  let sid = null;
  let transport = null;
  let jsonpSeq = 0;

  class IgeoError extends Error {
    constructor(code, svc, reason) {
      super(`Igeo ${svc} : erreur ${code}${reason ? ' (' + reason + ')' : ''}`);
      this.code = code;
      this.svc = svc;
    }
  }

  function encodeForm(svc, params, withSid) {
    const body = new URLSearchParams();
    body.set('svc', svc);
    body.set('params', JSON.stringify(params || {}));
    if (withSid && sid) body.set('sid', sid);
    return body;
  }

  async function viaProxy(svc, params) {
    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm(svc, params, true).toString()
    });
    if (!resp.ok) throw new Error('proxy HTTP ' + resp.status);
    return resp.json();
  }

  function viaJsonp(svc, params) {
    return new Promise((resolve, reject) => {
      const cb = `_igeoAdminJsonp_${Date.now()}_${jsonpSeq++}`;
      const script = document.createElement('script');
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error('Igeo ne répond pas (délai de 120 s dépassé)')); }, 120000);
      function cleanup() {
        settled = true;
        clearTimeout(timer);
        window[cb] = () => {};
        setTimeout(() => { delete window[cb]; }, 10000);
        script.remove();
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      const qs = encodeForm(svc, params, true);
      qs.set('callback', cb);
      script.src = `${API_URL}?${qs.toString()}`;
      const unreadable = () => {
        if (settled) return;
        cleanup();
        const err = new Error(`Igeo injoignable ou réponse illisible (${svc})`);
        err.unreadable = true;
        reject(err);
      };
      script.onerror = unreadable;
      script.onload = unreadable;
      document.head.appendChild(script);
    });
  }

  async function pickTransport() {
    if (transport) return transport;
    if (location.protocol.startsWith('http')) {
      try {
        const probe = await fetch(`${PROXY_URL}?svc=core/get_hw_types&params=%7B%7D`);
        const data = probe.ok ? await probe.json() : null;
        if (data && typeof data === 'object') {
          transport = 'proxy';
          return transport;
        }
      } catch (_e) { /* fallback JSONP */ }
    }
    transport = 'jsonp';
    return transport;
  }

  async function rawCall(svc, params) {
    const mode = await pickTransport();
    return mode === 'proxy' ? await viaProxy(svc, params) : await viaJsonp(svc, params);
  }

  let refreshPromise = null;

  async function ensureFreshSession() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const token = storedToken();
      if (!token) {
        throw new IgeoError(1, 'session', 'Session expirée et aucun token disponible');
      }
      sid = null;
      const res = await rawCall('token/login', { token, fl: 2 });
      if (res && res.eid) {
        sid = res.eid;
        startKeepAlive();
        return sid;
      }
      throw new IgeoError((res && res.error) || 1, 'token/login', res && res.reason);
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  let keepAliveInterval = null;

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(async () => {
      if (!sid) return;
      try {
        const res = await rawCall('core/duplicate', { operateAs: '', continueCurrentSession: true, checkService: '' });
        if (res && res.eid) sid = res.eid;
      } catch (_e) {}
    }, 150000);
  }

  function stopKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
  }

  async function call(svc, params, isRetry = false) {
    const data = await rawCall(svc, params);
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      if (data.error === 1 && !isRetry && storedToken() && svc !== 'token/login' && svc !== 'core/logout') {
        try {
          await ensureFreshSession();
          return await call(svc, params, true);
        } catch (_refreshErr) {}
      }
      throw new IgeoError(data.error, svc, data.reason);
    }
    return data;
  }

  async function batch(calls, isRetry = false) {
    if (!calls.length) return [];
    if (await pickTransport() === 'jsonp') {
      const out = [];
      for (const c of calls) {
        try {
          out.push(await call(c.svc, c.params));
        } catch (e) {
          if (e.code === 1) throw e;
          out.push({ error: e.code || 5, reason: e.message, unreadable: !!e.unreadable });
        }
      }
      return out;
    }
    try {
      const res = await call('core/batch', { params: calls, flags: 0 });
      if (Array.isArray(res) && res.some(item => item && item.error === 1)) {
        if (!isRetry && storedToken()) {
          await ensureFreshSession();
          return await batch(calls, true);
        }
        throw new IgeoError(1, 'core/batch', 'Session expirée');
      }
      return Array.isArray(res) ? res : [];
    } catch (err) {
      if (err.code === 1 && !isRetry && storedToken()) {
        await ensureFreshSession();
        return await batch(calls, true);
      }
      throw err;
    }
  }

  async function batchChunked(calls) {
    const budget = 400000;
    const out = [];
    let chunk = [];
    let size = 0;
    for (const c of calls) {
      const len = encodeURIComponent(JSON.stringify(c)).length;
      if (chunk.length && size + len > budget) {
        out.push(...await batch(chunk));
        chunk = [];
        size = 0;
      }
      chunk.push(c);
      size += len;
    }
    if (chunk.length) out.push(...await batch(chunk));
    return out;
  }

  async function loginWithToken(token) {
    sid = null;
    const res = await call('token/login', { token, fl: 2 });
    sid = res.eid;
    try { sessionStorage.setItem(STORAGE_KEY, token); } catch (_e) {}
    startKeepAlive();
    return sessionInfo(res);
  }

  async function useExistingSession(existingSid) {
    sid = existingSid;
    const res = await call('core/duplicate', { operateAs: '', continueCurrentSession: true, checkService: '' });
    if (res && res.eid) sid = res.eid;
    startKeepAlive();
    return sessionInfo(res);
  }

  function sessionInfo(res) {
    const user = res.user || {};
    return {
      userName: res.au || user.nm || '',
      userId: user.id,
      accountId: user.bact,
      timezone: user.prp && user.prp.tz
    };
  }

  function storedToken() {
    try { return sessionStorage.getItem(STORAGE_KEY); } catch (_e) { return null; }
  }

  async function logout() {
    stopKeepAlive();
    try { if (sid) await call('core/logout', {}); } catch (_e) {}
    sid = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_e) {}
  }

  function loginWithPopup() {
    return new Promise((resolve, reject) => {
      const w = 480;
      const h = 680;
      const left = Math.max(0, (window.screen.width - w) / 2);
      const top = Math.max(0, (window.screen.height - h) / 2);
      const popup = window.open(buildLoginUrl(TOKEN_RELAY_URL), 'igeo_admin_login', `width=${w},height=${h},left=${left},top=${top}`);
      if (!popup) {
        reject(new Error('popup-blocked'));
        return;
      }
      let settled = false;
      const finish = () => {
        settled = true;
        clearInterval(watcher);
        window.removeEventListener('message', onMessage);
      };
      const onMessage = (e) => {
        if (e.origin !== IGEO_HOST || typeof e.data !== 'string') return;
        const m = /^access_token=([0-9a-f]+)$/i.exec(e.data);
        if (!m) return;
        finish();
        resolve(m[1]);
      };
      const watcher = setInterval(() => {
        if (!popup.closed || settled) return;
        clearInterval(watcher);
        setTimeout(() => {
          if (settled) return;
          finish();
          reject(new Error('popup-closed'));
        }, 1000);
      }, 400);
      window.addEventListener('message', onMessage);
    });
  }

  function buildLoginUrl(redirectUri) {
    const q = new URLSearchParams({
      client_id: 'Igeo Admin Permissions',
      access_type: String(ACCESS_TYPE),
      activation_time: '0',
      duration: String(TOKEN_DURATION_SEC),
      flags: '0x1',
      redirect_uri: redirectUri,
      lang: 'fr'
    });
    return `${IGEO_HOST}/login.html?${q.toString()}`;
  }

  window.IgeoApi = {
    call,
    batch,
    batchChunked,
    loginWithToken,
    useExistingSession,
    storedToken,
    logout,
    buildLoginUrl,
    loginWithPopup,
    IgeoError,
    hasSession: () => !!sid
  };
})();
