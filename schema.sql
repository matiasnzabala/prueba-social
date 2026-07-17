-- Correr en Supabase SQL Editor, proyecto qynbveuojzfjbryuufdd (mismo que Ruleta/Aviso Stock)

create table if not exists social_tiendas (
  store_id text primary key,
  access_token text not null,
  scope text,
  instalada_en timestamptz,
  trial_ends_at timestamptz,
  pago boolean default false,
  activo boolean default true,
  posicion text default 'bottom-left',
  velocidad_seg int default 5,
  cantidad_mostrar int default 20
);

create table if not exists social_pedidos (
  id bigint generated always as identity primary key,
  store_id text not null references social_tiendas(store_id),
  order_id text not null,
  cliente_nombre text,
  producto_nombre text,
  creado_en timestamptz,
  unique(store_id, order_id)
);

create index if not exists idx_social_pedidos_store on social_pedidos(store_id, creado_en desc);
