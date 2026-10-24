-- ============================================================================
--  Migração: horário de funcionamento do estabelecimento (idempotente)
--  Execute no SQL Editor do Supabase (seguro para reexecutar).
--
--  Estrutura de `establishments.opening_hours` (jsonb), chaves "0".."6"
--  (0 = domingo, 6 = sábado):
--
--  {
--    "0": { "enabled": false, "open_time": "08:00", "close_time": "18:00" },
--    "1": { "enabled": true,  "open_time": "18:00", "close_time": "02:00" },
--    ...
--  }
--
--  `close_time` menor que `open_time` indica virada de noite (18:00 → 02:00).
--  Objeto vazio `{}` = loja sem horário configurado (considerada aberta,
--  mantendo o comportamento legado).
-- ============================================================================

alter table public.establishments
  add column if not exists opening_hours jsonb not null default '{}'::jsonb;

-- Bases legadas: normaliza nulos/formatos inesperados antes de aplicar a
-- constraint de objeto JSON.
update public.establishments
set opening_hours = '{}'::jsonb
where opening_hours is null
   or jsonb_typeof(opening_hours) <> 'object';

alter table public.establishments
  alter column opening_hours set default '{}'::jsonb,
  alter column opening_hours set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'establishments_opening_hours_is_object'
      and conrelid = 'public.establishments'::regclass
  ) then
    alter table public.establishments
      add constraint establishments_opening_hours_is_object
      check (jsonb_typeof(opening_hours) = 'object');
  end if;
end;
$$;

comment on column public.establishments.opening_hours is
  'Horários por dia da semana (chaves 0-6). Objeto vazio = sem configuração (loja aberta).';
