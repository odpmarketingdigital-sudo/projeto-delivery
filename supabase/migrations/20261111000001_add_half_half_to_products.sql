-- ============================================================================
--  Meio a meio (produtos com dois sabores)
--
--  Coluna:
--    - allow_half_half → true = o produto (sabor) pode ser vendido inteiro
--      (1 sabor) ou "meio a meio" (2 sabores).
--
--  Regras aplicadas pela aplicação (lib/halfHalf.ts):
--    - O produto marcado é um sabor de pizza combinável. No meio a meio, ele é
--      o 1º sabor e o cliente escolhe apenas o 2º, entre produtos ATIVOS da
--      MESMA categoria que também tenham `allow_half_half`.
--    - Sem escolher o 2º sabor, o item é vendido inteiro e mantém o preço
--      normal do produto.
--    - O preço unitário do meio a meio é o do sabor mais caro; adicionais são
--      somados por fora. Se algum sabor estiver sem preço (0), o pedido é
--      recusado no checkout tradicional para evitar cobrança incorreta.
--    - O item do pedido é gravado com o nome detalhado
--      ("Pizza Calabresa (Meio Calabresa / Meio Frango)") e com o objeto
--      `items[].half_half` (jsonb) contendo os sabores escolhidos.
--
--  Sem essa coluna, criar/editar produtos com o recurso falha
--  ("column products.allow_half_half does not exist"); a listagem do cardápio
--  e o checkout continuam funcionando (a flag é lida como ausente/false).
-- ============================================================================

alter table public.products
  add column if not exists allow_half_half boolean not null default false;

comment on column public.products.allow_half_half is
  'true = sabor vendido inteiro (1) ou meio a meio (2 sabores da mesma categoria habilitados); no meio a meio o preço é o do sabor mais caro.';
