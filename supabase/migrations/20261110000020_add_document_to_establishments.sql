-- ============================================================================
--  Migração: CPF/CNPJ do responsável pelo estabelecimento
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Contexto: o cadastro em `/cadastro` e o onboarding pós-Google
--  (`/completar-cadastro`) coletam o documento do dono da loja. Sem essas
--  colunas o insert em `establishments` falha com
--  "Could not find the 'document_number' column".
--
--  Formato salvo: apenas dígitos (máscara aplicada só na interface).
--    document_type   → 'cpf' | 'cnpj' (null em lojas legadas)
--    document_number → 11 dígitos (CPF) ou 14 (CNPJ)
-- ============================================================================

alter table public.establishments
  add column if not exists document_type text,
  add column if not exists document_number text;

comment on column public.establishments.document_type is
  'Tipo do documento do responsável: cpf | cnpj (null em lojas anteriores à migração).';

comment on column public.establishments.document_number is
  'Documento do responsável só com dígitos (11 = CPF, 14 = CNPJ).';

-- Normaliza qualquer valor legado antes de aplicar o check.
update public.establishments
   set document_type = lower(document_type)
 where document_type is not null
   and document_type <> lower(document_type);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'establishments_document_type_check'
       and conrelid = 'public.establishments'::regclass
  ) then
    alter table public.establishments
      add constraint establishments_document_type_check
      check (document_type is null or document_type in ('cpf', 'cnpj'));
  end if;
end $$;

-- Um mesmo CPF/CNPJ não pode manter duas lojas na plataforma.
-- Índice parcial: lojas legadas (document_number nulo) não são afetadas.
create unique index if not exists establishments_document_number_key
  on public.establishments (document_number)
  where document_number is not null;
