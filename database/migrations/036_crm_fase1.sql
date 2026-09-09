create table if not exists crm_empresas (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null,
  cif             text,
  email           text,
  telefono        text,
  fd_contact_id   text unique references fd_contacts(fd_contact_id),
  sector          text,
  origen          text not null default 'facturadirecta',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_crm_empresas_nombre on crm_empresas(lower(nombre));
create index if not exists idx_crm_empresas_email  on crm_empresas(lower(email));

create table if not exists crm_actividades (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references crm_empresas(id) on delete cascade,
  tipo            text not null,
  titulo          text not null,
  detalle         text,
  referencia_id   text,
  autor           text,
  fecha           timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists idx_crm_actividades_empresa_fecha on crm_actividades(empresa_id, fecha desc);
