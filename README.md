# Prueba Social

App TiendaNegocio: popup de "prueba social" que muestra compras recientes reales a los visitantes de la tienda ("Juan P. compró Zapatillas Nike · hace 5 min").

## Variables de entorno (Render)

- `TN_CLIENT_ID`, `TN_CLIENT_SECRET` — credenciales OAuth de la app en TiendaNegocio
- `APP_BASE_URL` — ej. `https://pruebasocial.hacecrecertutienda.com`
- `SUPABASE_URL`, `SUPABASE_KEY` — proyecto `qynbveuojzfjbryuufdd`
- `CRON_KEY` — clave para proteger `/cron/sync`
- `TRIAL_DIAS` — default 7
- `MP_PAYMENT_LINK` — link suscripción mensual Mercado Pago

## Setup

1. Correr `schema.sql` en Supabase SQL Editor.
2. Deploy en Render (start: `node server.js`).
3. Dominio custom `pruebasocial.hacecrecertutienda.com` apuntando al servicio Render.
4. Cron externo (cron-job.org) pegando a `/cron/sync?key=CRON_KEY` cada 5-15 min.
5. Configurar app en Portal de Referidos (URL callback: `{APP_BASE_URL}/callback`).

## Instalación en tienda del comerciante

Pegar en código personalizado del theme, antes de `</body>`:

```html
<script src="https://pruebasocial.hacecrecertutienda.com/widget.js?store=STORE_ID" defer></script>
```

## Activar pago manual (mismo flujo que Ruleta/Aviso Stock)

Entrar a Supabase SQL Editor y correr:

```sql
update social_tiendas set pago = true where store_id = 'XXXX';
select * from social_tiendas where store_id = 'XXXX';
```

Confirmar siempre con el SELECT después (la tabla UI de Supabase a veces no guarda de verdad).

## Notas técnicas

- Mismo esquema de cookie firmada (HMAC-SHA256) que Ruleta/Aviso Stock para proteger `/admin/:storeId`.
- Cache de pedidos en `social_pedidos`, el widget nunca pega directo a la API de TN (rate limit 40 req/10seg).
- Nombre cliente se muestra como "Nombre + inicial apellido" (nunca nombre completo), por privacidad.
- Pendiente confirmar estructura exacta de `GET /v1/orders` de la API real (campos `customer.name`, `products[].name`) contra una tienda real antes de ir a producción — el código asume la misma forma que `/v1/products` (clon de Tiendanube/Nuvemshop) pero no se probó todavía con pedidos reales.
