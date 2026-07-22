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

const USER_AGENT = `PopupVentas (${APP_BASE_URL})`;
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
  const existente = await leerTienda(storeId);
  if (existente) {
    // Reinstalación / re-callback de OAuth: solo refrescamos credenciales,
    // sin pisar pago/trial/config que ya tenía la tienda.
    const { error } = await supabase.from('social_tiendas')
      .update({ access_token: accessToken, scope })
      .eq('store_id', storeId);
    if (error) console.error('Error actualizando tienda existente:', error);
    return;
  }
  const trialEndsAt = new Date(Date.now() + Number(TRIAL_DIAS) * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('social_tiendas').insert({
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
  });
  if (error) console.error('Error guardando tienda:', error);
}

async function leerTienda(storeId) {
  const { data, error } = await supabase.from('social_tiendas').select('*').eq('store_id', storeId).maybeSingle();
  if (error) console.error('Error leyendo tienda:', error);
  return data || null;
}

async function suscribirWebhookBorrado(storeId, accessToken) {
  try {
    const resp = await fetch('https://developers.tiendanegocio.com/v1/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ url: `${APP_BASE_URL}/webhooks/app-deleted`, event: 'app/deleted' }),
    });
    if (!resp.ok) console.error(`No se pudo suscribir webhook app/deleted para ${storeId}:`, await resp.text());
  } catch (err) {
    console.error(`Error suscribiendo webhook app/deleted para ${storeId}:`, err);
  }
}

async function borrarDatosTienda(storeId) {
  await supabase.from('social_pedidos').delete().eq('store_id', storeId);
  await supabase.from('social_presencia').delete().eq('store_id', storeId);
  await supabase.from('social_eventos').delete().eq('store_id', storeId);
  await supabase.from('social_tiendas').delete().eq('store_id', storeId);
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
// Visualizadores activos — cada visitante en una ficha de producto manda
// un heartbeat cada ~20s (upsert por store_id+handle+visitor_id). Contar
// cuántos hay con last_seen reciente (últimos 45s) da "personas viendo
// esto ahora" sin necesidad de websockets.
// ---------------------------------------------------------------------
const PRESENCIA_VENTANA_SEG = 45;

async function registrarPresencia(storeId, handle, visitorId) {
  const { error } = await supabase.from('social_presencia').upsert({
    store_id: storeId,
    handle,
    visitor_id: visitorId,
    last_seen: new Date().toISOString(),
  }, { onConflict: 'store_id,handle,visitor_id' });
  if (error) console.error('Error registrando presencia:', error);
}

async function contarVisualizadores(storeId, handle) {
  const desde = new Date(Date.now() - PRESENCIA_VENTANA_SEG * 1000).toISOString();
  const { count, error } = await supabase
    .from('social_presencia')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .eq('handle', handle)
    .gte('last_seen', desde);
  if (error) { console.error('Error contando visualizadores:', error); return 0; }
  return count || 0;
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
    await suscribirWebhookBorrado(store_id, access_token);
    console.log(`✅ Tienda ${store_id} instaló Popup Ventas.`);
    agregarTiendaYSetearCookie(req, res, store_id);
    res.redirect(`/admin/${store_id}`);
  } catch (err) {
    console.error('Error en /callback:', err);
    res.status(500).send('Error interno al procesar la instalación.');
  }
});

app.get('/', (req, res) => {
  res.send('Popup Ventas backend funcionando ✅');
});

app.post('/webhooks/app-deleted', async (req, res) => {
  const storeId = req.body?.store_id;
  if (!storeId) return res.status(400).json({ error: 'Falta store_id' });
  await borrarDatosTienda(String(storeId));
  console.log(`🗑️ Datos de tienda ${storeId} borrados por webhook app/deleted.`);
  res.status(200).json({ ok: true });
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
    mostrar_visualizadores: tienda.mostrar_visualizadores !== false,
    minimo_visualizadores: tienda.minimo_visualizadores || 2,
  });
});

// El widget de ficha de producto manda un heartbeat cada ~20s mientras el
// visitante sigue en la página, y consulta el conteo actualizado.
app.post('/presencia/:storeId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { handle, visitorId } = req.body || {};
  if (!handle || !visitorId) return res.status(400).json({ error: 'faltan datos' });
  await registrarPresencia(req.params.storeId, handle, visitorId);
  const cantidad = await contarVisualizadores(req.params.storeId, handle);
  res.json({ cantidad });
});

app.get('/pedidos/:storeId', async (req, res) => {
  const tienda = await leerTienda(req.params.storeId);
  if (!tienda || !tiendaActiva(tienda) || !tienda.activo) return res.json([]);
  const pedidos = await leerPedidosRecientes(req.params.storeId, tienda.cantidad_mostrar);
  res.json(pedidos);
});

// ---------------------------------------------------------------------
// Estadísticas — el widget manda un evento 'vista' cuando arranca a
// mostrar popups (una vez por carga de página, fire-and-forget).
// ---------------------------------------------------------------------
app.options('/track', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.post('/track', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(204).end();
  const { storeId, tipo } = req.body || {};
  if (!storeId || tipo !== 'vista') return;
  const { error } = await supabase.from('social_eventos').insert({ store_id: storeId, tipo });
  if (error) console.error('Error guardando evento:', error);
});

async function contarVistas(storeId) {
  const { count, error } = await supabase
    .from('social_eventos').select('*', { count: 'exact', head: true }).eq('store_id', storeId);
  if (error) { console.error('Error contando vistas:', error); return 0; }
  return count || 0;
}

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
  if (!storeId && window.TN && window.TN.store && window.TN.store.id) {
    storeId = window.TN.store.id;
  }
  if (!storeId) return;

  var BASE = '${APP_BASE_URL}';
  function track(tipo) {
    try {
      fetch(BASE + '/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: storeId, tipo: tipo }), keepalive: true,
      });
    } catch (e) {}
  }

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
      'background:#fff;border-radius:16px;padding:18px 22px;' +
      'box-shadow:0 12px 32px rgba(0,0,0,0.18);font-family:sans-serif;max-width:380px;min-width:280px;' +
      'display:flex;gap:14px;align-items:center;opacity:0;transition:opacity 0.4s;';
    document.body.appendChild(contenedor);
    return contenedor;
  }

  function render(contenedor, pedido) {
    contenedor.innerHTML =
      '<div style="width:48px;height:48px;border-radius:50%;background:#E8632C;color:#fff;font-size:1.3rem;' +
        'display:flex;align-items:center;justify-content:center;font-weight:700;flex:none;">🛒</div>' +
      '<div style="min-width:0;">' +
        '<p style="margin:0;font-size:1.02rem;color:#222;font-weight:700;">' + pedido.cliente_nombre + ' compró</p>' +
        '<p style="margin:2px 0 0;font-size:0.95rem;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + pedido.producto_nombre + '</p>' +
        '<p style="margin:4px 0 0;font-size:0.82rem;color:#999;">' + tiempoRelativo(pedido.creado_en) + '</p>' +
      '</div>';
    contenedor.style.opacity = '1';
  }

  // --- Visualizadores activos: badge "X personas viendo esto ahora"
  // junto al botón de compra en la ficha del producto. ---
  function handleActual() {
    var m = window.location.pathname.match(/\\/producto\\/([^\\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function visitorId() {
    var key = 'prueba_social_visitor';
    var id = localStorage.getItem(key);
    if (!id) {
      id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, id);
    }
    return id;
  }

  function buscarBotonCompra() {
    var cand = document.querySelectorAll('button, a, div, input[type="submit"]');
    var rx = /agregar al carrito|añadir al carrito|comprar ahora|comprar/i;
    for (var i = 0; i < cand.length; i++) {
      var txt = (cand[i].textContent || cand[i].value || '').trim();
      if (txt.length > 0 && txt.length <= 40 && rx.test(txt)) return cand[i];
    }
    return null;
  }

  function iniciarVisualizadores(config) {
    if (!config.mostrar_visualizadores) return;
    var handle = handleActual();
    if (!handle) return;
    var boton = buscarBotonCompra();
    if (!boton || !boton.parentNode) return;

    var badge = document.createElement('div');
    badge.style.cssText = 'display:none;align-items:center;gap:6px;margin:10px 0;font-family:sans-serif;' +
      'font-size:0.85rem;color:#c2410c;font-weight:600;';
    badge.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#f97316;display:inline-block;' +
      'box-shadow:0 0 0 3px rgba(249,115,22,0.25);"></span><span id="prueba-social-visual-txt"></span>';
    boton.parentNode.insertBefore(badge, boton);
    var txt = badge.querySelector('#prueba-social-visual-txt');

    var minimo = config.minimo_visualizadores || 2;
    function actualizar() {
      fetch(BASE + '/presencia/' + storeId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle, visitorId: visitorId() }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var cantidad = (data && data.cantidad) || 0;
          if (cantidad >= minimo) {
            txt.textContent = cantidad + ' persona' + (cantidad === 1 ? '' : 's') + ' viendo esto ahora';
            badge.style.display = 'flex';
          } else {
            badge.style.display = 'none';
          }
        })
        .catch(function () {});
    }
    actualizar();
    setInterval(actualizar, 20000);
  }

  fetch(BASE + '/config/' + storeId)
    .then(function (r) { return r.json(); })
    .then(function (config) {
      if (!config || !config.activo) return;
      iniciarVisualizadores(config);
      fetch(BASE + '/pedidos/' + storeId)
        .then(function (r) { return r.json(); })
        .then(function (pedidos) {
          if (!pedidos || !pedidos.length) return;
          track('vista');
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
    return res.status(401).send('No pudimos identificar tu tienda. Volvé a abrir la app desde el panel de TiendaNegocio (Aplicaciones → Popup Ventas).');
  }
  if (tiendas.length === 1) return res.redirect(`/admin/${tiendas[0]}`);

  const filas = tiendas.map((id) => `<a class="fila-tienda" href="/admin/${id}">Tienda ${id}</a>`).join('');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Popup Ventas</title>
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
  <p>Seleccioná la tienda para configurar Popup Ventas.</p>
  ${filas}
</body>
</html>`);
});

app.post('/admin/:storeId/config', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) return res.status(403).send('No autorizado.');

  const { activo, posicion, velocidad_seg, cantidad_mostrar, mostrar_visualizadores, minimo_visualizadores } = req.body;
  await actualizarConfig(storeId, {
    activo: activo === 'on' || activo === true,
    posicion: posicion || 'bottom-left',
    velocidad_seg: Number(velocidad_seg) || 5,
    cantidad_mostrar: Number(cantidad_mostrar) || 20,
    mostrar_visualizadores: mostrar_visualizadores === 'on' || mostrar_visualizadores === true,
    minimo_visualizadores: Math.max(1, Number(minimo_visualizadores) || 2),
  });
  res.redirect(`/admin/${storeId}`);
});

const APPS_CATALOGO = [
  {
    nombre: 'Ruleta WhatsApp',
    descripcion: 'Ruleta de premios para captar leads y dar cupones a cambio de un giro.',
    estado: 'activa',
    icono: '🎡',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Aviso de Stock',
    descripcion: 'Avisa por email a tus clientes cuando un producto agotado vuelve a tener stock.',
    estado: 'activa',
    icono: '📦',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Barra de Envío Gratis',
    descripcion: 'Barra que motiva a sumar productos al carrito para llegar al envío gratis.',
    estado: 'activa',
    icono: '🚚',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Raspadita',
    descripcion: 'Raspadita de premios para captar leads y dar cupones a cambio de jugar.',
    estado: 'activa',
    icono: '🎟️',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Caja Sorpresa',
    descripcion: 'Caja sorpresa de premios para captar leads y dar cupones a cambio de abrirla.',
    estado: 'activa',
    icono: '🎁',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Popup de Salida',
    descripcion: 'Popup que detecta cuándo el visitante se va y le ofrece un cupón para que no abandone la tienda.',
    estado: 'activa',
    icono: '👋',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Venta Inteligente',
    descripcion: 'Cross-sell y upsell automáticos para subir el ticket promedio.',
    estado: 'activa',
    icono: '🧠',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Cuenta Regresiva',
    descripcion: 'Timer de urgencia para ofertas, que motiva a comprar antes de que se acabe el tiempo.',
    estado: 'activa',
    icono: '⏳',
    url: 'https://hacecrecertutienda.com',
  },
  {
    nombre: 'Tragamonedas',
    descripcion: 'Máquina tragamonedas de premios para captar leads y dar cupones al instante.',
    estado: 'activa',
    icono: '🎰',
    url: 'https://hacecrecertutienda.com',
  },
];

function generarAppsHTML() {
  const cards = APPS_CATALOGO.map((a) => {
    const activa = a.estado === 'activa';
    const badge = activa
      ? '<span class="app-badge app-badge--activa">Activa</span>'
      : '<span class="app-badge app-badge--proxima">Próximamente</span>';
    const contenido = `
      <div class="app-icon">${a.icono || '🧩'}</div>
      <div class="app-info">
        <div class="app-top"><span class="app-name">${a.nombre}</span>${badge}</div>
        <p class="app-desc">${a.descripcion}</p>
      </div>`;
    return activa && a.url
      ? `<a class="app-card app-card--link" href="${a.url}">${contenido}</a>`
      : `<div class="app-card">${contenido}</div>`;
  }).join('');

  return `
      <div class="section-label">Más herramientas para tu tienda</div>
      <div class="apps-grid">
        ${cards}
      </div>`;
}

app.get('/admin/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  const tiendasPermitidas = leerTiendasDeCookie(req);
  if (!tiendasPermitidas.includes(storeId)) {
    return res.status(403).send('No autorizado. Abrí la app desde el panel de TiendaNegocio (Aplicaciones → Popup Ventas).');
  }
  const tienda = await leerTienda(storeId);
  if (!tienda) return res.status(404).send('Tienda no encontrada o app no instalada.');

  const pedidos = await leerPedidosRecientes(storeId, 10);
  const vistas = await contarVistas(storeId);
  const filasPedidos = pedidos
    .map((p) => `<tr><td>${p.cliente_nombre}</td><td>${p.producto_nombre}</td><td>${new Date(p.creado_en).toLocaleString('es-AR')}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="vacio">Todavía no hay pedidos en cache. Esperá al próximo sync.</td></tr>';

  const diasRestantes = tienda.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(tienda.trial_ends_at).getTime() - Date.now()) / 86400000))
    : 0;
  const pctTrial = Math.max(0, Math.min(100, Math.round((diasRestantes / (Number(TRIAL_DIAS) || 7)) * 100)));
  const bannerPago = tienda.pago
    ? '<div class="banner banner-ok">✅ Suscripción activa.</div>'
    : diasRestantes > 0
      ? `<div class="banner banner-trial"><div class="trial-banner-top">⏳ Trial: ${diasRestantes} día(s) restante(s). <a href="${MP_PAYMENT_LINK}" target="_blank" rel="noopener">Activar suscripción</a></div><div class="trial-bar-track"><div class="trial-bar-fill" style="width:${pctTrial}%"></div></div></div>`
      : `<div class="banner banner-vencido">🔒 Trial vencido, la ruleta y el widget están apagados. <a href="${MP_PAYMENT_LINK}" target="_blank" rel="noopener">Activar suscripción</a></div>`;

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Popup Ventas — Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0d0f10; --bg-alt:#161a1c; --bg-card:#15181a;
    --ink:#e9edee; --ink-dim:#8b969a;
    --pink:#d4ff4f; --coral:#ff6b5e; --mint:#d4ff4f; --canary:#d4ff4f;
    --line:#262b2e;
    --sh-sm:none;
    --sh-md:none;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  @keyframes bgDrift{
    0%{ background-position:0% 0%, 100% 0%, 0 0; }
    100%{ background-position:10% 15%, 90% 20%, 0 0; }
  }
  @keyframes fadeUp{ from{opacity:0;transform:translateY(10px);} to{opacity:1;transform:translateY(0);} }
  @keyframes pulseDot{ 0%,100%{ box-shadow:0 0 0 0 color-mix(in srgb, var(--pink) 55%, transparent); } 50%{ box-shadow:0 0 0 5px transparent; } }
  body{
    background:
      radial-gradient(ellipse 700px 420px at 12% -8%, color-mix(in srgb, var(--pink) 7%, transparent), transparent),
      radial-gradient(ellipse 600px 400px at 100% 10%, color-mix(in srgb, var(--pink) 5%, transparent), transparent),
      var(--bg);
    background-size:140% 140%, 140% 140%, 100% 100%;
    animation:bgDrift 18s ease-in-out infinite alternate;
    color:var(--ink); font-family:'Space Grotesk', sans-serif; font-weight:500; padding:40px 20px 80px;
  }
  @media (prefers-reduced-motion: reduce){ body{ animation:none !important; } *{ transition:none !important; } }
  .wrap{ max-width:760px; margin:0 auto; }
  .eyebrow{ font-family:'Space Mono', monospace; text-transform:uppercase; letter-spacing:0.1em; font-size:0.7rem; color:var(--pink); font-weight:700; display:block; margin-bottom:10px; }
  h1{ font-family:'Archivo Black', sans-serif; font-weight:400; text-transform:uppercase; font-size:1.5rem; margin-bottom:8px; }
  .subtitle{ color:var(--ink-dim); font-size:0.95rem; margin-bottom:28px; max-width:60ch; font-weight:500; }
  .status-hero{ background:var(--bg-card); border:1px solid var(--line); border-radius:2px; box-shadow:var(--sh-sm); padding:22px 24px; margin-bottom:8px; animation:fadeUp .5s ease both; }
  .status-hero-top{ display:flex; align-items:flex-start; justify-content:space-between; gap:20px; flex-wrap:wrap; }
  .status-hero-stats-label{ font-family:'Space Mono', monospace; text-transform:uppercase; letter-spacing:0.08em; font-size:0.72rem; font-weight:700; color:var(--ink-dim); margin-top:20px; }
  .status-hero-stats{ display:flex; gap:12px; margin-top:8px; flex-wrap:wrap; }
  .stat-tile{ flex:1; min-width:100px; background:var(--bg); border:1px solid var(--line); border-radius:2px; padding:12px 14px; display:flex; flex-direction:column; gap:2px; }
  .stat-num{ font-family:'Archivo Black', sans-serif; font-size:1.6rem; line-height:1; }
  .stat-label{ font-family:'Space Mono', monospace; text-transform:uppercase; letter-spacing:0.06em; font-size:0.68rem; color:var(--ink-dim); font-weight:700; }
  .banner{ padding:14px 18px; border-radius:2px; margin-bottom:24px; font-size:0.88rem; border:1px solid var(--line); box-shadow:var(--sh-sm); font-weight:600; animation:fadeUp .5s ease both; }
  .banner a{ color:inherit; font-weight:700; text-decoration:underline; }
  .banner-ok{ background:var(--mint); color:#0d0f10; }
  .banner-trial{ background:var(--canary); color:#111; display:flex; flex-direction:column; gap:10px; }
  .banner-vencido{ background:var(--coral); color:#111; }
  .trial-banner-top{ display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  .trial-bar-track{ height:5px; background:rgba(17,17,17,0.2); border-radius:2px; overflow:hidden; }
  .trial-bar-fill{ height:100%; background:#111; border-radius:2px; transition:width .6s cubic-bezier(.2,.8,.2,1); }
  .card{ background:var(--bg-card); border:1px solid var(--line); box-shadow:var(--sh-sm); border-radius:2px; padding:20px 24px; margin-bottom:24px; transition:transform .18s ease, border-color .18s ease; animation:fadeUp .5s ease both; }
  .card:hover{ border-color:color-mix(in srgb, var(--pink) 45%, var(--line)); transform:translateY(-2px); }
  label{ display:block; font-size:0.82rem; color:var(--ink-dim); font-weight:700; margin:14px 0 6px; }
  select, input{ width:100%; padding:10px 12px; border-radius:2px; border:1px solid var(--line); background:var(--bg-alt); color:var(--ink); font-size:0.9rem; font-family:'Space Grotesk', sans-serif; font-weight:600; transition:border-color .18s ease, transform .18s ease; }
  select:focus, input:focus{ outline:none; border-color:var(--pink); transform:scale(1.01); }
  .check-row{ display:flex; align-items:center; gap:10px; margin-top:10px; }
  .check-row input{ width:auto; }
  .switch-wrap{
    display:flex; align-items:center; gap:10px; cursor:pointer;
    background:var(--bg-card); border:1px solid var(--line); box-shadow:var(--sh-sm);
    border-radius:999px; padding:10px 16px 10px 10px; flex:none; width:fit-content;
  }
  .switch-wrap input{ display:none; }
  .switch-track{
    width:40px; height:22px; border-radius:999px; background:var(--bg-alt);
    border:1px solid var(--line);
    position:relative; transition:background .2s ease; flex:none;
  }
  .switch-track::after{
    content:''; position:absolute; top:1px; left:1px;
    width:16px; height:16px; border-radius:50%; background:var(--ink-dim);
    transition:transform .2s ease, background .2s ease;
  }
  .switch-wrap input:checked + .switch-track{ background:color-mix(in srgb, var(--mint) 25%, var(--bg-alt)); border-color:var(--mint); }
  .switch-wrap input:checked + .switch-track::after{ transform:translateX(18px); background:var(--mint); animation:pulseDot 2.2s ease-in-out infinite; }
  .switch-label{ font-size:0.88rem; font-weight:700; white-space:nowrap; }
  .actions{ margin-top:32px; }
  button.submit{
    width:100%;
    background:var(--pink); color:#0d0f10; border:none;
    padding:15px 28px; border-radius:2px; font-weight:700; font-size:1rem;
    cursor:pointer; transition:transform .18s ease;
    font-family:'Space Grotesk', sans-serif; box-shadow:var(--sh-sm);
  }
  button.submit:hover{ transform:translateY(-2px) scale(1.01); }
  button.submit:active{ transform:translateY(0) scale(0.99); }
  table{ width:100%; border-collapse:collapse; background:var(--bg-card); border:1px solid var(--line); box-shadow:var(--sh-sm); border-radius:2px; overflow:hidden; }
  th{ text-align:left; font-family:'Space Mono', monospace; text-transform:uppercase; font-size:0.7rem; letter-spacing:0.06em; color:var(--ink-dim); font-weight:700; padding:14px 16px; border-bottom:1px solid var(--line); }
  td{ padding:14px 16px; border-bottom:1px solid var(--line); font-size:0.9rem; }
  tr:last-child td{ border-bottom:none; }
  .vacio{ color:var(--ink-dim); text-align:center; padding:32px 16px; }
  .install-card{ background:var(--bg-card); border:1px solid var(--line); box-shadow:var(--sh-sm); border-radius:2px; padding:20px 24px; margin-top:28px; animation:fadeUp .5s ease both; }
  .install-text{ color:var(--ink-dim); font-size:0.88rem; line-height:1.6; font-weight:500; }
  .install-text code{ background:var(--bg-alt); padding:2px 6px; border-radius:2px; border:1px solid var(--line); font-family:'Space Mono', monospace; font-size:0.8rem; color:var(--pink); }
  .admin-footer{ margin-top:40px; padding-top:24px; border-top:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; }
  .admin-footer .brand{ font-family:'Space Mono', monospace; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-dim); }
  .admin-footer .brand a{ color:var(--pink); font-weight:700; text-decoration:underline; }
  .admin-footer .soporte{ display:inline-flex; align-items:center; gap:6px; background:var(--mint); color:#0d0f10; border:none; padding:8px 16px; border-radius:999px; font-weight:700; font-size:0.82rem; box-shadow:var(--sh-sm); text-decoration:none; transition:transform .18s ease; }
  .admin-footer .soporte:hover{ transform:translateY(-2px); }

  .section-label{
    font-family:'Space Mono', monospace; text-transform:uppercase;
    letter-spacing:0.08em; font-size:0.72rem; color:var(--pink); font-weight:700;
    margin:32px 0 16px;
  }
  .apps-grid{ display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; }
  .app-card{
    display:flex; gap:14px; align-items:flex-start;
    background:var(--bg-card); border:1px solid var(--line); box-shadow:var(--sh-sm);
    border-radius:2px; padding:18px 20px; text-decoration:none; color:var(--ink);
    transition:transform .18s ease, border-color .18s ease; animation:fadeUp .5s ease both;
  }
  .app-card--link{ cursor:pointer; }
  .app-card--link:hover{ transform:translateY(-2px); border-color:color-mix(in srgb, var(--pink) 45%, var(--line)); }
  .app-card--link:hover .app-icon{ transform:scale(1.15) rotate(-4deg); }
  .app-icon{ font-size:1.6rem; line-height:1; flex:none; margin-top:2px; display:inline-block; transition:transform .2s ease; }
  .app-info{ flex:1; min-width:0; }
  .app-top{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
  .app-name{ font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:1rem; }
  .app-desc{ color:var(--ink-dim); font-size:0.85rem; line-height:1.4; font-weight:500; }
  .app-badge{
    font-family:'Space Mono', monospace; font-size:0.62rem; text-transform:uppercase;
    letter-spacing:0.06em; padding:3px 9px; border-radius:999px; flex:none;
    border:1px solid var(--line); font-weight:700;
  }
  .app-badge--activa{ background:var(--mint); color:#0d0f10; }
  .app-badge--proxima{ background:var(--canary); color:#111; }
  @media (max-width:640px){
    .apps-grid{ grid-template-columns:1fr; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <form method="POST" action="/admin/${storeId}/config">
      <div class="status-hero">
        <div class="status-hero-top">
          <div>
            <span class="eyebrow">Popup Ventas · Tienda ${storeId}</span>
            <h1>Notificaciones de compra</h1>
          </div>
          <label class="switch-wrap">
            <input type="checkbox" name="activo" ${tienda.activo ? 'checked' : ''} onchange="actualizarEstado(this)" />
            <span class="switch-track"></span>
            <span class="switch-label" id="switch-label-txt">${tienda.activo ? 'Widget activo' : 'Widget desactivado'}</span>
          </label>
        </div>
        <div class="status-hero-stats-label">Estadísticas</div>
        <div class="status-hero-stats">
          <div class="stat-tile"><span class="stat-num">${vistas}</span><span class="stat-label">Vistas</span></div>
          <div class="stat-tile"><span class="stat-num">${pedidos.length}</span><span class="stat-label">Pedidos en cache</span></div>
        </div>
      </div>
      <p class="subtitle">Popup que muestra compras recientes a tus visitantes para generar confianza.</p>
      ${bannerPago}

      <div class="card">
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
        <div class="actions">
          <button type="submit" class="submit">Guardar</button>
        </div>
      </div>

      <div class="card">
        <label class="switch-wrap" style="margin-bottom:0;">
          <input type="checkbox" name="mostrar_visualizadores" ${tienda.mostrar_visualizadores !== false ? 'checked' : ''} />
          <span class="switch-track"></span>
          <span class="switch-label">Mostrar "X personas viendo esto ahora"</span>
        </label>
        <p style="color:var(--ink-dim);font-size:0.85rem;margin-top:10px;">Badge junto al botón de compra en la ficha del producto, cuando hay varios visitantes viendo el mismo producto al mismo tiempo.</p>
        <label for="minimo_visualizadores">Mostrar a partir de (mínimo de personas)</label>
        <input type="number" id="minimo_visualizadores" name="minimo_visualizadores" min="1" max="20" value="${tienda.minimo_visualizadores || 2}" />
        <div class="actions">
          <button type="submit" class="submit">Guardar</button>
        </div>
      </div>
    </form>

    <h1 style="font-size:1.1rem;margin-bottom:16px;">Últimos pedidos en cache</h1>
    <table>
      <thead><tr><th>Cliente</th><th>Producto</th><th>Fecha</th></tr></thead>
      <tbody>${filasPedidos}</tbody>
    </table>

    ${generarAppsHTML()}

    <div class="admin-footer">
      <span class="brand">Una app de <a href="https://hacecrecertutienda.com" target="_blank" rel="noopener">hacecrecertutienda.com</a></span>
      <a class="soporte" href="https://wa.me/5490000000000" target="_blank" rel="noopener">💬 Soporte por WhatsApp</a>
    </div>
  </div>
  <script>
    function actualizarEstado(checkbox) {
      document.getElementById('switch-label-txt').textContent = checkbox.checked ? 'Widget activo' : 'Widget desactivado';
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Servidor Popup Ventas corriendo en puerto ${PORT}`);
});
