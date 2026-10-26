/**
 * Worker Cloudflare de admin.igeopilot.com
 *
 * - Sert les fichiers statiques de public/ (binding ASSETS).
 * - /wialon-api : relais vers l'API Igeo (Wialon Local) permettant la lecture et
 *   l'écriture des champs administratifs (aflds), champs personnalisés (flds),
 *   champs de profil (pflds) et le remplacement d'identifiant de balise (unit/update_device_type).
 */
const IGEO_API = 'https://track.igeo.africa/wialon/ajax.html';

const ALLOWED_SERVICES = new Set([
  'token/login',
  'core/logout',
  'core/duplicate',
  'core/batch',
  'core/search_items',
  'core/search_item',
  'core/get_hw_types',
  'core/update_item',
  'item/update_admin_field',
  'item/update_custom_field',
  'item/update_profile_field',
  'item/update_name',
  'unit/update_device_type',
  'unit/update_hw_params',
  'unit/get_drive_rank_settings',
  'unit/update_drive_rank_settings',
  'user/get_items_access',
  'user/update_item_access',
  'account/get_account_data',
  'file/list',
  'file/write',
  'file/read',
  'file/get',
  'file/put',
  'file/mkdir',
  'file/rm',
  'unit/registry_custom_event',
  'unit/registry_maintenance_event',
  'unit/registry_status_event',
  'unit/upload_image',
  'messages/load_interval',
  'messages/unload',
  // Onglet « Audit » (lecture seule) : rapports intégrés Logins / Log, détail des alertes,
  // rapports planifiés et modèles, droits des utilisateurs sur les véhicules.
  'report/exec_report',
  'report/select_result_rows',
  'report/get_result_subrows',
  'report/cleanup_result',
  'report/get_report_data',
  'resource/get_job_data',
  'resource/get_notification_data',
  'core/check_accessors'
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function isAllowed(svc, paramsText) {
  if (!ALLOWED_SERVICES.has(svc)) return false;
  if (svc !== 'core/batch') return true;
  try {
    const params = JSON.parse(paramsText || '{}');
    const calls = Array.isArray(params.params) ? params.params : (Array.isArray(params) ? params : []);
    return calls.every(c => c && c.svc !== 'core/batch' && ALLOWED_SERVICES.has(c.svc));
  } catch (_e) {
    return false;
  }
}

async function proxyIgeo(request, url) {
  let form;
  if (request.method === 'POST') form = new URLSearchParams(await request.text());
  else if (request.method === 'GET') form = new URLSearchParams(url.searchParams);
  else return json({ error: 4, reason: 'Méthode non autorisée' }, 405);

  form.delete('callback');
  const svc = form.get('svc') || '';
  if (!isAllowed(svc, form.get('params'))) {
    return json({ error: 7, reason: `Service non autorisé par le relais : ${svc}` }, 403);
  }

  if (svc === 'unit/upload_image') {
    try {
      const sid = form.get('sid') || '';
      const params = JSON.parse(form.get('params') || '{}');
      const itemId = Number(params.itemId);
      const dataUrl = String(params.dataUrl || '');
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
      if (!itemId || !m) {
        return json({ error: 4, reason: 'Paramètres image invalides pour unit/upload_image' }, 400);
      }
      const mimeType = m[1];
      const b64 = m[2];
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      const mp = new FormData();
      mp.append('params', JSON.stringify({ itemId, eventHash: 'igeo_unit_photo' }));
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      mp.append('icon_file', new Blob([bytes], { type: mimeType }), `igeo_photo_${itemId}.${ext}`);

      const uploadUrl = `${IGEO_API}?svc=unit/upload_image&sid=${encodeURIComponent(sid)}`;
      const upstream = await fetch(uploadUrl, {
        method: 'POST',
        body: mp
      });
      const text = await upstream.text();
      return new Response(text || '{}', {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return json({ error: 999, reason: `Erreur upload_image : ${e.message}` }, 502);
    }
  }

  try {
    const upstream = await fetch(IGEO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    if (upstream.status >= 500) {
      return json({ error: 999, reason: `Igeo indisponible (HTTP ${upstream.status})` }, 502);
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return json({ error: 999, reason: `Igeo injoignable : ${e.message}` }, 502);
  }
}

async function handlePhotoRoute(request, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['photo', unitId, entryId]
  const unitId = parts[1] || '';
  const entryId = parts[2] || '';
  if (!unitId || !entryId) return json({ error: 4, reason: 'URL photo incomplète' }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/photo/${encodeURIComponent(unitId)}/${encodeURIComponent(entryId)}`, {
    method: 'GET'
  });

  if (request.method === 'POST') {
    try {
      const payload = await request.json();
      const dataUrl = String((payload && payload.dataUrl) || '');
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
      if (!m) return json({ error: 4, reason: 'Image dataUrl invalide' }, 400);

      const mimeType = m[1];
      const b64 = m[2];
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      const imgResponse = new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*'
        }
      });
      await cache.put(cacheKey, imgResponse);
      return json({ ok: true, url: `${url.origin}/photo/${unitId}/${entryId}` });
    } catch (e) {
      return json({ error: 500, reason: e.message }, 500);
    }
  }

  if (request.method === 'DELETE') {
    await cache.delete(cacheKey);
    return json({ ok: true });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    return Response.redirect(`${url.origin}/?unit=${encodeURIComponent(unitId)}&photo=${encodeURIComponent(entryId)}`, 302);
  }

  return json({ error: 4, reason: 'Méthode non supportée' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/wialon-api') return proxyIgeo(request, url);
    if (url.pathname.startsWith('/photo/')) return handlePhotoRoute(request, url);
    return env.ASSETS.fetch(request);
  }
};
