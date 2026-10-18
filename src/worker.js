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
  'unit/update_drive_rank_settings'
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/wialon-api') return proxyIgeo(request, url);
    return env.ASSETS.fetch(request);
  }
};
