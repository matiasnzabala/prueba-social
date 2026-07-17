require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // /pedidos y /config los llama widget.js desde OTRO dominio (la tienda
  // del comerciante) — sin responder el preflight OPTIONS el navegador
  // bloquea el request antes de que llegue acá.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.urlencoded({ extended: true }));

const {
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  APP_BASE_URL,
  SUPABASE_URL,
  SUPABASE_KEY,
  CRON_KEY = 'cambiar-esta-clave',
  TRIAL_DIAS = 7,
  MP_PAYMENT_LINK = '',
  PORT = 3000,
} = process.env;

const USER_AGENT = `PruebaSocial (${APP_BASE_URL})`;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------
// Cookie de sesión firmada (mismo esquema que Ruleta/Aviso Stock).
// Sin esto, /admin/:storeId es adivinable y muestra pedidos de otro
// comerciante. Guarda LISTA de tiendas (mismo navegador puede tener
// más de una instalada).
// ---------------------------------------------------------------------
function firmarLista(valor) {
  const firma = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(valor).digest('hex');
  return `${valor}.${firma}`;
}

function leerTiendasDeCookie(req) {
  const header = req.headers.cookie;
  if (!header) return [];
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith('store_session='));
  if (!match) return [];
  const cookieVal = decodeURIComponent(match.slice('store_session='.length));
  const idx = cookieVal.lastIndexOf('.');
  if (idx === -1) return [];
  const valor = cookieVal.slice(0, idx);
  const firma = cookieVal.slice(idx + 1);
  const esperada = crypto.createHmac('sha256', TN_CLIENT_SECRET).update(valor).digest('hex');
  if (firma.length !== esperada.length) return [];
  const coincide = crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  if (!coincide) return [];
  return valor.split(',').filter(Boolean);
}

function agregarTiendaYSetearCookie(req, res, nuevoStoreId) {
  const actuales = leerTiendasDeCookie(req);
  if (!actuales.includes(String(nuevoStoreId))) actuales.push(String(nuevoStoreId));
  const valor = encodeURIComponent(firmarLista(actuales.join(',')));
  res.setHeader('Set-Cookie', `store_session=${valor}; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Path=/`);
}

// ---------------------------------------------------------------------
// Tiendas instaladas
// ---------------------------------------------------------------------
async function guardarTienda(storeId, accessToken, scope) {
  const trialEndsAt = new Date(Date.now() + Number(TRIAL_DIAS) * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('social_tiendas').upsert({
    store_id: storeId,
    access_token: accessToken,
    scope,
    instalada_en: new Date().toISOString(),
    trial_ends_at: trialEndsAt,
    pago: false,
    activo: true,
    posicion: 'bottom-left',
    velocidad_seg: 5,
    cantidad_mostrar: 20,
  }, { onConflict: 'store_id', ignoreDuplicates: false });
  // ignoreDuplicates false + upsert sin pisar trial/pago si ya existía:
  if (error) console.error('Error guardando tienda:', error);
}

async function leerTienda(storeId) {
  const { data, error } = await supabase.from('social_tiendas').select('*').eq('store_id', storeId).maybeSingle();
  if (error) console.error('Error leyendo tienda:', error);
  return data || null;
}

async function listarTiendas() {
  const { data, error } = await supabase.from('social_tiendas').select('*');
  if (error) {
    console.error('Error listando tiendas:', error);
    return [];
  }
  return data || [];
}

async function actualizarConfig(storeId, cambios) {
  const { error } = await supabase.from('social_tiendas').update(cambios).eq('store_id', storeId);
  if (error) console.error('Error actualizando config:', error);
  return !error;
}

function tiendaActiva(tienda) {
  if (!tienda) return false;
  if (tienda.pago) return true;
  if (!tienda.trial_ends_at) return false;
  return new Date(tienda.trial_ends_at).getTime() > Date.now();
}

// ---------------------------------------------------------------------
// Cache de pedidos recientes (widget lee ACÁ, nunca pega directo a la
// API de TN en cada visita — evita rate limit 40 req/10seg).
// ---------------------------------------------------------------------
function formatearNombre(nombreCompleto) {
  if (!nombreCompleto) return 'Alguien';
  const partes = String(nombreCompleto).trim().split(/\s+/);
  const nombre = partes[0];
  const inicialApellido = partes.length > 1 ? partes[1].charAt(0).toUpperCase() + '.' : '';
  return inicialApellido ? `${nombre} ${inicialApellido}` : nombre;
}

async function upsertPedido(storeId, pedido) {
  const primerProducto = (pedido.products && pedido.products[0]) || {};
  const nombreCliente = (pedido.customer && pedido.customer.name) || pedido.contact_name || '';
  const { error } = await supabase.from('social_pedidos').upsert({
    store_id: storeId,
    order_id: pedido.id,
    cliente_nombre: formatearNombre(nombreCliente),
    producto_nombre: (primerProducto.name && primerProducto.name.es) || primerProducto.name || 'un producto',
    creado_en: pedido.created_at || new Date().toISOString(),
  }, { onConflict: 'store_id,order_id' });
  if (error) console.error('Error guardando pedido en cache:', error);
}

async function leerPedidosRecientes(storeId, cantidad) {
  const { data, error } = await supabase
    .from('social_pedidos')
    .select('cliente_nombre, producto_nombre, creado_en')
    .eq('store_id', storeId)
    .order('creado_en', { ascending: false })
    .limit(cantidad || 20);
  if (error) console.error('Error leyendo pedidos:', error);
  return data || [];
}

// ---------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro code en la URL.');

  try {
    const response = await fetch('https://developers.tiendanegocio.com/v1/oauth/app/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Error al obtener token:', data);
      return res.status(500).send('No se pudo completar la instalación.');
    }

    const { access_token, store_id: storeIdRaw, scope } = data.data || {};
    if (!access_token || !storeIdRaw) {
      console.error('Respuesta inesperada del token endpoint:', data);
      return res.status(500).send('Respuesta inesperada de TiendaNegocio.');
    }
    const store_id = String(storeIdRaw); // TN lo manda como número, no string

    await guardarTienda(store_id, access_token, scope);
    console.log(`✅ Tienda ${store_id} instaló Prueba Social.`);
    agregarTiendaYSetearCookie(req, res, store_id);
    res.redirect(`/admin/${store_id}`);
  } catch (err) {
    console.error('Error en /callback:', err);
    res.status(500).send('Error interno al procesar la instalación.');
  }
});

app.get('/', (req, res) => {
  res.send('Prueba Social backend funcionando ✅');
});

// ---------------------------------------------------------------------
// CRON — recorre tiendas instaladas, trae pedidos recientes de la API
// real y actualiza el cache. Responde YA y sigue en background (mismo
// motivo que Aviso Stock: cron-job.org gratis corta a los 30s).
// ---------------------------------------------------------------------
async function sincronizarTodasLasTiendas() {
  const tiendas = await listarTiendas();
  const resumen = [];

  for (const tienda of tiendas) {
    try {
      const r = await fetch('https://developers.tiendanegocio.com/v1/orders?page=1&per_page=30', {
        headers: { Authorization: tienda.access_token, 'User-Agent': USER_AGENT, accept: 'application/json' },
      });
      if (!r.ok) {
        console.error(`Error trayendo pedidos de tienda ${tienda.store_id}:`, r.status);
        continue;
      }
      const data = await r.json();
      const pedidos = data.results || [];
      for (const pedido of pedidos) {
        await upsertPedido(tienda.store_id, pedido);
      }
      resumen.push({ store_id: tienda.store_id, pedidos: pedidos.length });
    } catch (err) {
      console.error(`Error procesando tienda ${tienda.store_id}:`, err);
    }
  }

  console.log('✅ Sync de pedidos terminado.', JSON.stringify(resumen));
  return resumen;
}

app.get('/cron/sync', (req, res) => {
  if (req.query.key !== CRON_KEY) return res.status(403).json({ error: 'clave inválida' });
  res.json({ ok: true, iniciado: true, nota: 'sync corriendo en background, revisá los logs de Render' });
  sincronizarTodasLasTiendas().catch((err) => console.error('Error en sincronizarTodasLasTiendas:', err));
});

// ---------------------------------------------------------------------
// /config — el widget lo consulta primero para saber si mostrar algo
// (activo, trial vencido, posición, velocidad, cantidad).
// ---------------------------------------------------------------------
app.get('/config/:storeId', async (req, res) => {
  const tienda = await leerTienda(req.params.storeId);
  if (!tienda) return res.json({ activo: false });
  const activo = tienda.activo && tiendaActiva(tienda);
  res.json({
    activo,
    posicion: tienda.posicion || 'bottom-left',
    velocidad_seg: tienda.velocidad_seg || 5,
    cantidad_mostrar: tienda.cantidad_mostrar || 20,
  });
});

app.get('/pedidos/:storeId', async (req, res) => {
  const tienda = await leerTienda(req.params.storeId);
  if (!tienda || !tiendaActiva(tienda) || !tienda.activo) return res.json([]);
  const pedidos = await leerPedidosRecientes(req.params.storeId, tienda.cantidad_mostrar);
  res.json(pedidos);
});

// ---------------------------------------------------------------------
// Widget global — popup esquina, rota pedidos recientes.
// ---------------------------------------------------------------------
app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(`(function () {
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/widget.js') !== -1) return scripts[i];
    }
    return null;
  })();
  if (!scriptTag) return;

  var params = new URLSearchParams(scriptTag.src.split('?')[1] || '');
  var storeId = params.get('store');
  if (!storeId) return;

  var BASE = '${APP_BASE_URL}';

  function posicionCSS(pos) {
    if (pos === 'bottom-right') return 'bottom:20px;right:20px;';
    if (pos === 'top-left') return 'top:20px;left:20px;';
    if (pos === 'top-right') return 'top:20px;right:20px;';
    return 'bottom:20px;left:20px;';
  }

  function tiempoRelativo(fechaISO) {
    var diffMs = Date.now() - new Date(fechaISO).getTime();
    var min = Math.floor(diffMs / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return 'hace ' + min + ' min';
    var horas = Math.floor(min / 60);
    if (horas < 24) return 'hace ' + horas + 'h';
    return 'hace ' + Math.floor(horas / 24) + 'd';
  }

  function crearContenedor(pos) {
    var contenedor = document.createElement('div');
    contenedor.id = 'prueba-social-widget';
    contenedor.style.cssText = 'position:fixed;' + posicionCSS(pos) + 'z-index:999999;' +
      'background:#fff;border-radius:12px;padding:14px 16px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.15);font-family:sans-serif;max-width:300px;' +
      'display:flex;gap:10px;align-items:center;opacity:0;transition:opacity 0.4s;';
    document.body.appendChild(contenedor);
    return contenedor;
  }

  function render(contenedor, pedido) {
    contenedor.innerHTML =
      '<div style="width:36px;height:36px;border-radius:50%;background:#E8632C;color:#fff;' +
        'display:flex;align-items:center;justify-content:center;font-weight:700;flex:none;">🛒</div>' +
      '<div style="min-width:0;">' +
        '<p style="margin:0;font-size:0.85rem;color:#222;font-weight:600;">' + pedido.cliente_nombre + ' compró</p>' +
        '<p style="margin:0;font-size:0.82rem;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + pedido.producto_nombre + '</p>' +
        '<p style="margin:2px 0 0;font-size:0.72rem;color:#999;">' + tiempoRelativo(pedido.creado_en) + '</p>' +
      '</div>';
    contenedor.style.opacity = '1';
  }

  fetch(BASE + '/config/' + storeId)
    .then(function (r) { return r.json(); })
    .then(function (config) {
      if (!config || !config.activo) return;
      fetch(BASE + '/pedidos/' + storeId)
        .then(function (r) { return r.json(); })
        .then(function (pedidos) {
          if (!pedidos || !pedidos.length) return;
          var contenedor = crearContenedor(config.posicion);
          var i = 0;
          function mostrarSiguiente() {
            render(contenedor, pedidos[i % pedidos.length]);
            i++;
          }
          mostrarSiguiente();
          setInterval(function () {
            contenedor.style.opacity = '0';
            setTimeout(mostrarSiguiente, 400);
          }, (config.velocidad_seg || 5) * 1000);
        })
        .catch(function () {});
    })
    .catch(function () {});
})();
`);
});

// ---------------------------------------------------------------------
// Panel de administración
// ---------------------------------------------------------------------
app.get('/admin', async (req, res) => {
  const tiendas = leerTiendasDeCookie(req);
  if (tiendas.length === 0) {
    return res.status(401).send('No pudimos identificar tu tienda. Volvé a abrir la app desde el panel de TiendaNegocio (Aplicaciones → Prueba Social).');
  }
  if (tiendas.length === 1) return res.redirect(`/admin/${tiendas[0]}`);

  const filas = tiendas.map((id) => `<a class="fila-tienda" href="/admin/${id}">Tienda ${id}</a>`).join('');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Prueba Social</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  body{ font-family:'Space Grotesk', sans-serif; font-weight:500; background:#fdf9f0; color:#111111; padding:40px 20px; }
  h1{ font-family:'Archivo Black', sans-serif; font-weight:400; text-transform:uppercase; font-size:1.5rem; margin-bottom:8px; }
  p{ color:#5b5648; margin-bottom:24px; }
  .fila-tienda{ display:block; padding:16px; margin-bottom:12px; background:#ffffff; border:2px solid #111111; box-shadow:4px 4px 0px 0px #111111; border-radius:14px; color:#111111; text-decoration:none; font-weight:700; transition:transform .12s ease; }
  .fila-tienda:hover{ transform:translate(-2px,-2px); box-shadow:6px 6px 0px 0px #111111; }
</style></head>
<body>
  <h1>🛒 Elegí tu tienda</h1>
  <p>Seleccioná la tienda para configurar Prueba Social.</p>
  ${filas}
</body>
</html>`);
});

app.post('/admin/:storeId/config', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) return res.status(403).send('No autorizado.');

  const { activo, posicion, velocidad_seg, cantidad_mostrar } = req.body;
  await actualizarConfig(storeId, {
    activo: activo === 'on' || activo === true,
    posicion: posicion || 'bottom-left',
    velocidad_seg: Number(velocidad_seg) || 5,
    cantidad_mostrar: Number(cantidad_mostrar) || 20,
  });
  res.redirect(`/admin/${storeId}`);
});

app.get('/admin/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) {
    return res.status(403).send('No autorizado. Abrí la app desde el panel de TiendaNegocio (Aplicaciones → Prueba Social).');
  }
  const tienda = await leerTienda(storeId);
  if (!tienda) return res.status(404).send('Tienda no encontrada o app no instalada.');

  const pedidos = await leerPedidosRecientes(storeId, 10);
  const filasPedidos = pedidos
    .map((p) => `<tr><td>${p.cliente_nombre}</td><td>${p.producto_nombre}</td><td>${new Date(p.creado_en).toLocaleString('es-AR')}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="vacio">Todavía no hay pedidos en cache. Esperá al próximo sync.</td></tr>';

  const diasRestantes = tienda.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(tienda.trial_ends_at).getTime() - Date.now()) / 86400000))
    : 0;
  const bannerPago = tienda.pago
    ? '<div class="banner banner-ok">✅ Suscripción activa.</div>'
    : diasRestantes > 0
      ? `<div class="banner banner-trial">⏳ Trial: ${diasRestantes} día(s) restante(s). <a href="${MP_PAYMENT_LINK}" target="_blank" rel="noopener">Activar suscripción</a></div>`
      : `<div class="banner banner-vencido">🔒 Trial vencido, la ruleta y el widget están apagados. <a href="${MP_PAYMENT_LINK}" target="_blank" rel="noopener">Activar suscripción</a></div>`;

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prueba Social — Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#fdf9f0; --bg-alt:#f4f0e4; --bg-card:#ffffff;
    --ink:#111111; --ink-dim:#5b5648;
    --pink:#ff3d81; --coral:#ff6b5e; --mint:#3ddc97; --canary:#ffd23f;
    --sh-sm:4px 4px 0px 0px #111111;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ background:var(--bg); color:var(--ink); font-family:'Space Grotesk', sans-serif; font-weight:500; padding:40px 20px 80px; }
  .wrap{ max-width:760px; margin:0 auto; }
  .eyebrow{ font-family:'Space Mono', monospace; text-transform:uppercase; letter-spacing:0.1em; font-size:0.7rem; color:var(--pink); font-weight:700; display:block; margin-bottom:10px; }
  h1{ font-family:'Archivo Black', sans-serif; font-weight:400; text-transform:uppercase; font-size:1.5rem; margin-bottom:8px; }
  .subtitle{ color:var(--ink-dim); font-size:0.95rem; margin-bottom:28px; max-width:60ch; font-weight:500; }
  .banner{ padding:14px 18px; border-radius:14px; margin-bottom:24px; font-size:0.88rem; border:2px solid var(--ink); box-shadow:var(--sh-sm); font-weight:600; }
  .banner a{ color:inherit; font-weight:700; text-decoration:underline; }
  .banner-ok{ background:var(--mint); }
  .banner-trial{ background:var(--canary); }
  .banner-vencido{ background:var(--coral); }
  .card{ background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; padding:20px 24px; margin-bottom:24px; }
  label{ display:block; font-size:0.82rem; color:var(--ink-dim); font-weight:700; margin:14px 0 6px; }
  select, input{ width:100%; padding:10px 12px; border-radius:8px; border:2px solid var(--ink); background:var(--bg-alt); color:var(--ink); font-size:0.9rem; font-family:'Space Grotesk', sans-serif; font-weight:600; }
  select:focus, input:focus{ outline:none; border-color:var(--pink); }
  .check-row{ display:flex; align-items:center; gap:10px; margin-top:10px; }
  .check-row input{ width:auto; }
  button{ margin-top:18px; background:var(--pink); color:var(--ink); border:2px solid var(--ink); padding:12px 20px; border-radius:999px; font-weight:700; cursor:pointer; box-shadow:var(--sh-sm); transition:transform .1s ease, box-shadow .1s ease; font-family:'Space Grotesk', sans-serif; }
  button:hover{ transform:translate(-1px,-1px); box-shadow:5px 5px 0px 0px var(--ink); }
  button:active{ transform:translate(2px,2px); box-shadow:0px 0px 0px 0px var(--ink); }
  table{ width:100%; border-collapse:collapse; background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; overflow:hidden; }
  th{ text-align:left; font-family:'Space Mono', monospace; text-transform:uppercase; font-size:0.7rem; letter-spacing:0.06em; color:var(--ink-dim); font-weight:700; padding:14px 16px; border-bottom:2px solid var(--ink); }
  td{ padding:14px 16px; border-bottom:1px solid #e3ddc9; font-size:0.9rem; }
  tr:last-child td{ border-bottom:none; }
  .vacio{ color:var(--ink-dim); text-align:center; padding:32px 16px; }
  .install-card{ background:var(--bg-card); border:2px solid var(--ink); box-shadow:var(--sh-sm); border-radius:16px; padding:20px 24px; margin-top:28px; }
  .install-text{ color:var(--ink-dim); font-size:0.88rem; line-height:1.6; font-weight:500; }
  .install-text code{ background:var(--canary); padding:2px 6px; border-radius:4px; border:1px solid var(--ink); font-family:'Space Mono', monospace; font-size:0.8rem; color:var(--ink); }
  .admin-footer{ margin-top:40px; padding-top:24px; border-top:2px solid var(--ink); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; }
  .admin-footer .brand{ font-family:'Space Mono', monospace; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-dim); }
  .admin-footer .brand a{ color:var(--ink); font-weight:700; text-decoration:underline; }
  .admin-footer .soporte{ display:inline-flex; align-items:center; gap:6px; background:var(--mint); color:var(--ink); border:2px solid var(--ink); padding:8px 16px; border-radius:999px; font-weight:700; font-size:0.82rem; box-shadow:var(--sh-sm); text-decoration:none; transition:transform .1s ease; }
  .admin-footer .soporte:hover{ transform:translate(-1px,-1px); }
</style>
</head>
<body>
  <div class="wrap">
    <span class="eyebrow">Prueba Social · Tienda ${storeId}</span>
    <h1>Notificaciones de compra</h1>
    <p class="subtitle">Popup que muestra compras recientes a tus visitantes para generar confianza.</p>
    ${bannerPago}

    <form class="card" method="POST" action="/admin/${storeId}/config">
      <div class="check-row">
        <input type="checkbox" id="activo" name="activo" ${tienda.activo ? 'checked' : ''} />
        <label for="activo" style="margin:0;">Widget activo</label>
      </div>
      <label for="posicion">Posición</label>
      <select id="posicion" name="posicion">
        <option value="bottom-left" ${tienda.posicion === 'bottom-left' ? 'selected' : ''}>Abajo izquierda</option>
        <option value="bottom-right" ${tienda.posicion === 'bottom-right' ? 'selected' : ''}>Abajo derecha</option>
        <option value="top-left" ${tienda.posicion === 'top-left' ? 'selected' : ''}>Arriba izquierda</option>
        <option value="top-right" ${tienda.posicion === 'top-right' ? 'selected' : ''}>Arriba derecha</option>
      </select>
      <label for="velocidad_seg">Rotar cada (segundos)</label>
      <input type="number" id="velocidad_seg" name="velocidad_seg" min="2" max="60" value="${tienda.velocidad_seg || 5}" />
      <label for="cantidad_mostrar">Cantidad de pedidos a rotar</label>
      <input type="number" id="cantidad_mostrar" name="cantidad_mostrar" min="1" max="50" value="${tienda.cantidad_mostrar || 20}" />
      <button type="submit">Guardar</button>
    </form>

    <h1 style="font-size:1.1rem;margin-bottom:16px;">Últimos pedidos en cache</h1>
    <table>
      <thead><tr><th>Cliente</th><th>Producto</th><th>Fecha</th></tr></thead>
      <tbody>${filasPedidos}</tbody>
    </table>

    <div class="install-card">
      <p class="install-text">Pegá esto UNA VEZ en el código personalizado de tu tema (antes de <code>&lt;/body&gt;</code>):<br><br>
      <code>&lt;script src="${APP_BASE_URL}/widget.js?store=${storeId}" defer&gt;&lt;/script&gt;</code></p>
    </div>
    <div class="admin-footer">
      <span class="brand">Una app de <a href="https://hacecrecertutienda.com" target="_blank" rel="noopener">hacecrecertutienda.com</a></span>
      <a class="soporte" href="https://wa.me/5490000000000" target="_blank" rel="noopener">💬 Soporte por WhatsApp</a>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Servidor Prueba Social corriendo en puerto ${PORT}`);
});
