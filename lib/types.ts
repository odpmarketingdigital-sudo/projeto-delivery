import type { AsaasSubaccountProfile } from "./asaasSubaccount";
import type { DeliveryType } from "./delivery";
import type { SubscriptionStatus } from "./subscriptions";

export interface ProductOption {
  id: string;
  name: string;
  price: number;
}

export interface ProductOptionGroup {
  id: string;
  title: string;
  /** Instrução exibida ao cliente (ex.: "Escolha entre 1 e 3 opções"). */
  description?: string;
  required: boolean;
  minSelect?: number;
  maxSelect?: number;
  options: ProductOption[];
}

export interface Product {
  id: string;
  nome: string;
  descricao: string;
  preco: number;
  categoria: string;
  /** Alias em inglês para `categoria` (ex: "Lanches", "Pizzas"). */
  category?: string;
  image_url: string;
  option_groups?: ProductOptionGroup[];
  /** Loja dona do produto (snapshot usado pelo checkout). */
  establishmentId?: string;
  /**
   * true = o produto controla estoque limitado (`stock_quantity`).
   * false/ausente = estoque ilimitado (sempre disponível).
   */
  track_stock?: boolean;
  /**
   * Quantidade disponível quando `track_stock` está ativo.
   * Quando `track_stock = true` e este valor é 0, o item aparece "Esgotado".
   */
  stock_quantity?: number;
}

export interface CartItem {
  id: string;
  productId: string;
  quantidade: number;
  selectedOptions: ProductOption[];
  notes?: string;
  /** Preço unitário (base + adicionais) */
  unitPrice: number;
  /** (preço base + adicionais) * quantidade */
  itemTotalPrice: number;
  /**
   * Snapshot do produto no momento da adição ao carrinho (nome, preço base,
   * imagem, loja e categoria). Permite que a vitrine/checkout exibam o item
   * mesmo sem recarregar o cardápio — e sem depender de `lib/mockData`.
   * Itens antigos persistidos sem snapshot continuam válidos (campos opcionais).
   */
  productName?: string;
  basePrice?: number;
  imageUrl?: string;
  establishmentId?: string;
  categoryName?: string;
}

export type OrderStatus =
  | "pendente"
  | "preparando"
  | "entrega"
  | "finalizado"
  | "cancelado";

/** Item de pedido no formato jsonb gravado em `public.orders.items`. */
export interface PanelOrderItem {
  product_id?: string;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  addons?: Array<{ id: string; name: string; price: number }>;
  notes?: string;
}

/** Endereço de entrega (jsonb `customer_address`). */
export interface PanelOrderAddress {
  street: string;
  number: string;
  neighborhood: string;
  /** Cidade informada/selecionada no checkout. */
  city?: string | null;
  complement?: string;
  reference?: string;
  /** CEP do endereço (somente dígitos). */
  cep?: string | null;
  /** Coordenadas do endereço usadas no cálculo da rota (Places/CEP). */
  latitude?: number | null;
  longitude?: number | null;
  /** `place_id` do Google para reabrir o local no mapa. */
  place_id?: string | null;
}

/**
 * Pedido real do painel (linha de `public.orders` via GET /api/orders).
 * Mantém `Order` (mock legado) intacto para não quebrar outros usos.
 */
export interface PanelOrder {
  id: string;
  establishment_id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_address: PanelOrderAddress | null;
  items: PanelOrderItem[];
  subtotal: number;
  delivery_fee: number;
  total: number;
  payment_method: string;
  change_for: number | null;
  notes: string | null;
  /**
   * Situação do pagamento online (migração 20261110000028):
   * `pendente` | `pago` | `expirado` | `cancelado`. Pedidos pagos na entrega
   * permanecem `pendente`.
   */
  payment_status?: string | null;
  /** Id da cobrança PIX no Asaas (`orders.asaas_payment_id`). */
  asaas_payment_id?: string | null;
  /** Momento da confirmação do pagamento online (`payment_confirmed_at`). */
  payment_confirmed_at?: string | null;
  /** Tipo informado pela loja, quando disponível (`entrega`/`retirada`). */
  delivery_type?: string | null;
  status: OrderStatus;
  /** Motivo informado pelo atendente ao cancelar (coluna `cancellation_reason`). */
  cancellation_reason?: string | null;
  /** Código do cupom aplicado no checkout (null quando não houve cupom). */
  coupon_code?: string | null;
  /** Desconto concedido pelo cupom (coluna `coupon_discount`). */
  coupon_discount?: number | null;
  /** Previsão normalizada exibida ao cliente (ex.: "30-45 min"). */
  estimated_delivery_time?: string | null;
  /** Instante previsto da entrega (coluna `estimated_delivery_at`). */
  estimated_delivery_at?: string | null;
  /**
   * Distância usada no cálculo da entrega (km) — coluna
   * `delivery_distance_km`, migração 20261110000024.
   */
  delivery_distance_km?: number | null;
  /** Tempo de percurso estimado (minutos) — `delivery_duration_minutes`. */
  delivery_duration_minutes?: number | null;
  /**
   * Origem da distância: `google_routes` (rota real) ou `haversine`
   * (linha reta) — coluna `delivery_distance_source`.
   */
  delivery_distance_source?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Aliases de status aceitos na borda (UI/params) e normalizados para o
 * status canônico do banco: `em_preparo` → `preparando`,
 * `saiu_para_entrega` → `entrega`, `concluido` → `finalizado`.
 */
export const ORDER_STATUS_ALIASES: Record<string, OrderStatus> = {
  em_preparo: "preparando",
  saiu_para_entrega: "entrega",
  concluido: "finalizado",
};

/** Normaliza qualquer string de status para o valor canônico (ou null). */
export function normalizeOrderStatus(value: unknown): OrderStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const canonical: OrderStatus[] = [
    "pendente",
    "preparando",
    "entrega",
    "finalizado",
    "cancelado",
  ];
  if ((canonical as string[]).includes(v)) return v as OrderStatus;
  return ORDER_STATUS_ALIASES[v] ?? null;
}

export interface OrderItem {
  produto: string;
  quantidade: number;
  preco: number;
}

export interface Order {
  id: string;
  numero: number;
  cliente: string;
  itens: OrderItem[];
  total: number;
  status: OrderStatus;
  data: string;
  hora: string;
  /** Previsão de entrega normalizada (ex.: "30-45 min"). */
  estimated_delivery_time?: string | null;
  /** Instante previsto da entrega. */
  estimated_delivery_at?: string | null;
}

/** Papéis de acesso (RBAC) disponíveis no sistema. */
export type UserRole = "super_admin" | "admin" | "cliente";

/** Usuário administrativo gerenciado pelo Super Admin no painel. */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: "ativo" | "inativo";
  created_at: string;
  /** Nome do estabelecimento (contas do tipo admin/estabelecimento). */
  establishment?: string;
  /** Senha gerada no cadastro (mock) — usada pelo botão "Copiar Acesso". */
  password?: string;
}

/**
 * Horário de funcionamento de um dia da semana.
 * Os horários usam o formato "HH:mm" (ex.: "18:00").
 * `close_time` menor que `open_time` indica virada de noite (18:00 → 02:00).
 */
export interface OpeningHoursDay {
  enabled: boolean;
  open_time: string;
  close_time: string;
}

/**
 * Horários de funcionamento por dia da semana.
 * Chaves "0".."6" (0 = domingo, 6 = sábado) — formato persistido em
 * `establishments.opening_hours` (jsonb).
 */
export type OpeningHours = Record<string, OpeningHoursDay>;

/**
 * Estabelecimento (loja) gerenciado pelo Super Admin no painel.
 * Cada registro tem uma conta de acesso em `auth.users` (`user_id`).
 */
export interface Establishment {
  id: string;
  /** Referência ao usuário dono do acesso (auth.users). Cascade na exclusão. */
  user_id: string;
  /** Nome da loja (estabelecimento). */
  name: string;
  /** Nome do responsável (dono). */
  owner_name: string;
  /** E-mail de contato (também é o e-mail de login da conta de acesso). */
  email: string;
  /** Telefone de contato (opcional; null quando não informado). */
  phone: string | null;
  /**
   * CPF/CNPJ do estabelecimento (coluna `document_number`, migração
   * 20261110000020 — só dígitos). Usado para pré-preencher o recebimento
   * online (subconta Asaas).
   */
  document_number?: string | null;
  /** WhatsApp oficial da loja (coluna `whatsapp`, migração 20261110000006). */
  whatsapp?: string | null;
  /**
   * Liga/desliga o envio do resumo do pedido para o WhatsApp da loja no
   * checkout (coluna `whatsapp_checkout_enabled`, migração 20261110000016).
   * Ausente em bases legadas — tratado como ativo (`!== false`).
   */
  whatsapp_checkout_enabled?: boolean | null;
  /**
   * Modo catálogo: quando true, a sacola envia o pedido/orçamento direto para o
   * WhatsApp da loja e o checkout tradicional é ignorado (coluna
   * `direct_whatsapp_checkout`, migração 20261110000017).
   * Ausente em bases legadas — tratado como desligado (`=== true`).
   */
  direct_whatsapp_checkout?: boolean | null;
  /**
   * Liberação do Modo catálogo pelo Super Admin (coluna
   * `catalog_mode_allowed`, migração 20261110000025). Enquanto for `false`, a
   * chave fica bloqueada no painel da loja e o cardápio público ignora
   * `direct_whatsapp_checkout`. Ausente em bases legadas → tratado como `false`.
   */
  catalog_mode_allowed?: boolean | null;
  status: "ativo" | "inativo";
  /**
   * Slug público usado na URL exclusiva do cardápio (rota `/[slug]`).
   * Derivado do nome; pode ser null em bases legadas (tratado com fallback).
   */
  slug?: string | null;
  /** URL da logo do estabelecimento (coluna `logo_url`). */
  logo_url?: string | null;
  /** URL do banner/cover do estabelecimento (coluna `banner_url`). */
  banner_url?: string | null;
  /**
   * Texto exibido abaixo do nome no cardápio público (coluna `description`).
   * Quando vazio/null, a vitrine exibe o selo "PEDIDOS ONLINE" como fallback.
   */
  description?: string | null;
  /**
   * Horários de funcionamento por dia da semana (coluna `opening_hours`).
   * Ausente/vazio em bases legadas — nesse caso a loja é considerada aberta.
   */
  opening_hours?: OpeningHours | null;
  /** Modelo de frete (migração 20261110000014). Ausente = taxa fixa. */
  delivery_type?: DeliveryType | null;
  /** Taxa fixa de entrega (também fallback do modelo por distância). */
  delivery_fee?: number | string | null;
  /** Distância inclusa na taxa base (km). */
  distance_base_km?: number | string | null;
  /** Valor cobrado até `distance_base_km`. */
  distance_base_fee?: number | string | null;
  /** Valor por km excedente. */
  distance_extra_km_fee?: number | string | null;
  /** Raio máximo de entrega em km (null = sem limite). */
  max_delivery_radius_km?: number | string | null;
  /** CEP da loja usado como origem do cálculo (somente dígitos). */
  store_cep?: string | null;
  store_latitude?: number | string | null;
  store_longitude?: number | string | null;
  /** Tempo mínimo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_min?: number | string | null;
  /** Tempo máximo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_max?: number | string | null;
  /**
   * Fim do período de teste grátis (coluna `trial_ends_at`).
   * Ver `lib/subscriptions.ts` para a regra dos 30 dias.
   */
  trial_ends_at?: string | null;
  /** Estado da assinatura (coluna `subscription_status`). */
  subscription_status?: SubscriptionStatus | null;
  /** ID da assinatura no gateway de pagamento (coluna `subscription_id`). */
  subscription_id?: string | null;
  /** ID do cliente no gateway de pagamento (coluna `customer_payment_id`). */
  customer_payment_id?: string | null;
  /** Plano contratado (coluna `plan_id`). */
  plan_id?: string | null;
  /**
   * Momento do cancelamento da assinatura (coluna `canceled_at`).
   * Preenchido por `POST /api/billing/cancel` — migração 20261110000022.
   */
  canceled_at?: string | null;
  /**
   * Vencimento da cobrança em aberto (coluna `payment_due_date`, migração
   * 20261110000023). Null quando não há fatura pendente.
   */
  payment_due_date?: string | null;
  /** Link da fatura no Asaas (banner de regularização do painel). */
  payment_invoice_url?: string | null;
  /** Momento do último pagamento recebido (coluna `last_payment_at`). */
  last_payment_at?: string | null;
  /**
   * Momento da suspensão automática por atraso acima de 15 dias
   * (coluna `overdue_suspended_at`, migração 20261110000023).
   */
  overdue_suspended_at?: string | null;
  /**
   * Split de pagamentos (Asaas Subcontas) — migração 20261110000027.
   * ID da subconta (conta de recebimento) no Asaas; null quando o pagamento
   * online ainda não foi conectado pelo lojista.
   */
  asaas_account_id?: string | null;
  /** Wallet ID da subconta Asaas — destino dos splits de pagamento. */
  asaas_wallet_id?: string | null;
  /** Snapshot dos dados de recebimento enviados ao Asaas (formulário). */
  asaas_subaccount?: AsaasSubaccountProfile | null;
  /** Chave PIX de resgate informada pelo lojista. */
  pix_key?: string | null;
  /** Liga/desliga o PIX online no cardápio (Split de Pagamentos). */
  accept_pix_online?: boolean | null;
  created_at: string;
  updated_at: string;
}

/**
 * Categoria do cardápio de um estabelecimento (ex: "Lanches", "Bebidas").
 * Persistida na tabela `public.categories`. A ordem de exibição é `position`.
 */
export interface Category {
  id: string;
  establishment_id: string;
  name: string;
  /**
   * Ordem de exibição. Pode vir nula em bases legadas — a ordenação trata o
   * fallback (ver `lib/menuOrder.ts`).
   */
  position: number | null;
  /** Alias alternativo de ordenação, quando a base usa `sort_order`. */
  sort_order?: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Adicional/opcional de um produto do cardápio (ex: "Bacon +R$ 5,00").
 * Persistida na tabela `public.addons`, vinculada ao produto (`product_id`)
 * e ao estabelecimento (`establishment_id`).
 */
export interface MenuAddon {
  id: string;
  establishment_id: string;
  product_id: string;
  name: string;
  /** Preço adicional cobrado por unidade (numeric(10,2) no banco). */
  price: number;
  /**
   * Legado: a coluna continua no banco/API por compatibilidade. Na interface
   * os adicionais são sempre opcionais — a vitrine não exige seleção.
   */
  is_required: boolean;
  /** false = opcional pausado (não exibido no cardápio). */
  is_active: boolean;
  /**
   * Grupo de opcionais ao qual o item pertence (`addon_groups.id`).
   * `null`/ausente = item "sem grupo" (legado ou avulso).
   */
  group_id?: string | null;
  /** Ordem de exibição (tolerante a nulo; ver `lib/menuOrder.ts`). */
  position: number | null;
  /** Alias alternativo de ordenação, quando a base usa `sort_order`. */
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Grupo de opcionais de um produto (estilo Menudino/iFood).
 * Persistido na tabela `public.addon_groups`.
 *
 * Ex.: "Escolha o tipo de carne" (obrigatório, mínimo 1, máximo 1) ou
 * "Escolha 3 acompanhamentos" (obrigatório, mínimo 3, máximo 3).
 */
export interface MenuAddonGroup {
  id: string;
  establishment_id: string;
  product_id: string;
  name: string;
  /** Instrução exibida ao cliente (ex.: "Escolha entre 1 e 3 opções"). */
  description: string;
  /** true = grupo de seleção obrigatória na vitrine. */
  is_required: boolean;
  /** Mínimo de itens que o cliente deve escolher no grupo. */
  min_selectors: number;
  /** Máximo de itens que o cliente pode escolher no grupo. */
  max_selectors: number;
  /** false = grupo oculto/pausado (não exibido no cardápio). */
  is_active: boolean;
  /** Ordem de exibição (tolerante a nulo; ver `lib/menuOrder.ts`). */
  position: number | null;
  /** Alias alternativo de ordenação, quando a base usa `sort_order`. */
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Produto do cardápio gerido no painel (/painel/produtos).
 * Persistido na tabela `public.products`.
 *
 * Distinto do `Product` do cardápio do cliente (mock), que permanece intacto
 * para não afetar o carrinho/checkout atuais.
 */
export interface MenuProduct {
  id: string;
  establishment_id: string;
  category_id: string | null;
  /** Nome da categoria relacionada (preenchido pelo GET /api/products). */
  category_name?: string | null;
  name: string;
  description: string;
  price: number;
  image_url: string;
  /** false = item pausado (esgotado) — não aparece como disponível. */
  is_active: boolean;
  /**
   * true = controla estoque limitado (usa `stock_quantity`).
   * false/ausente = estoque ilimitado.
   */
  track_stock?: boolean;
  /** Quantidade em estoque (relevante apenas quando `track_stock = true`). */
  stock_quantity?: number;
  /** Ordem de exibição (tolerante a nulo; ver `lib/menuOrder.ts`). */
  position: number | null;
  /** Alias alternativo de ordenação, quando a base usa `sort_order`. */
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

/** Payload retornado pelo GET /api/products (categorias + produtos + adicionais). */
export interface MenuData {
  categories: Category[];
  products: MenuProduct[];
  /** Adicionais de todos os produtos do estabelecimento (filtre por `product_id`). */
  addons: MenuAddon[];
  /**
   * Grupos de opcionais de todos os produtos do estabelecimento
   * (filtre por `product_id`). Opcional para compatibilidade com payloads
   * antigos; use `menu.addon_groups ?? []`.
   */
  addon_groups?: MenuAddonGroup[];
}

/**
 * Produto extraído de um cardápio (PDF/imagem) pela IA (Gemini).
 * Usado apenas na revisão do painel — antes de gravar em lote em
 * `public.products` via `POST /api/ai/import-menu/save`.
 */
export interface ImportedMenuProduct {
  name: string;
  description: string;
  /** Preço em reais (ex.: 29.9). 0 quando o preço está ausente/ilegível. */
  price: number;
}

/** Categoria extraída de um cardápio pela IA (ver `ImportedMenu`). */
export interface ImportedMenuCategory {
  name: string;
  products: ImportedMenuProduct[];
}

/**
 * Payload do Structured Output devolvido por `POST /api/ai/import-menu`.
 * O Gemini é instruído a responder exatamente neste formato.
 */
export interface ImportedMenu {
  categories: ImportedMenuCategory[];
}

/**
 * Dados públicos do estabelecimento expostos pela vitrine (/) e pelo checkout.
 * Vem do GET /api/menu (somente lojas `status = 'ativo'`).
 */
export interface StorefrontInfo {
  id: string;
  /** Slug público (URL: `/?slug=xxx`). Pode ser null em bases legadas. */
  slug: string | null;
  name: string;
  description: string | null;
  banner_url: string | null;
  logo_url: string | null;
  /** WhatsApp do estabelecimento (usado na confirmação do pedido). */
  whatsapp: string | null;
  /**
   * Indica se a loja oferece o envio do resumo do pedido no WhatsApp ao
   * finalizar o checkout (`establishments.whatsapp_checkout_enabled`).
   * Ausente/`undefined` = ativo (compatibilidade com bases legadas).
   */
  whatsapp_checkout_enabled?: boolean;
  /**
   * Modo catálogo (`establishments.direct_whatsapp_checkout`, migração
   * 20261110000017). Quando `true`, a sacola envia o pedido/orçamento direto
   * para o WhatsApp da loja, sem passar pelo checkout.
   *
   * ATENÇÃO: já vem "efetivo" de `/api/menu` — a API só devolve `true` quando o
   * Super Admin liberou a loja (`catalog_mode_allowed`, migração
   * 20261110000025). As telas não precisam revalidar a liberação.
   * Ausente = desligado.
   */
  direct_whatsapp_checkout?: boolean;
  /**
   * PIX Online (Split Asaas — migração 20261110000027). Já vem "efetivo" de
   * `/api/menu`: `true` somente quando a loja conectou a subconta
   * (`asaas_account_id`) e ligou "Aceitar PIX Online" no painel.
   * Ausente = desligado.
   */
  accept_pix_online?: boolean;
  /** Telefone de contato (fallback quando `whatsapp` não existe). */
  phone: string | null;
  /** Taxa de entrega padrão cobrada no checkout. */
  delivery_fee: number;
  /** Modelo de frete configurado pela loja. */
  delivery_type: DeliveryType;
  /** Distância inclusa na taxa base (km) — modelo por distância. */
  distance_base_km?: number;
  /** Valor cobrado até `distance_base_km`. */
  distance_base_fee?: number;
  /** Valor por km excedente. */
  distance_extra_km_fee?: number;
  /** Raio máximo de entrega em km (null = sem limite). */
  max_delivery_radius_km?: number | null;
  /** Tempo mínimo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_min?: number | null;
  /** Tempo máximo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_max?: number | null;
  /**
   * Horários de funcionamento por dia da semana (coluna `opening_hours`).
   * Objeto vazio = loja sem horário configurado (considerada aberta).
   */
  opening_hours: OpeningHours;
}

/**
 * Payload do GET /api/menu (público, sem sessão): loja + cardápio ativo.
 * `products`/`categories`/`addons` vêm já filtrados por `is_active = true`.
 */
export interface StorefrontMenu extends MenuData {
  establishment: StorefrontInfo;
}

/** Período de agregação do dashboard de vendas. */
export type DashboardPeriod = "day" | "month" | "year";

/** Ponto da série temporal do dashboard (hora, dia ou mês). */
export interface DashboardSeriesPoint {
  /** Chave estável do bucket (ex.: "h18", "2026-10-20", "2026-10"). */
  key: string;
  /** Rótulo curto para exibição (ex.: "18h", "20/10", "Out"). */
  label: string;
  revenue: number;
  orders: number;
}

/** Destaque de dia (maior/menor venda) no período consultado. */
export interface DashboardDayHighlight {
  date: string;
  label: string;
  revenue: number;
  orders: number;
}

/** Payload do GET /api/dashboard. */
export interface DashboardData {
  period: DashboardPeriod;
  value: string;
  startIso: string;
  endIso: string;
  revenue: number;
  orders: number;
  averageTicket: number;
  /** Pedidos cancelados no período (não entram nos indicadores). */
  canceledOrders: number;
  topDay: DashboardDayHighlight | null;
  bottomDay: DashboardDayHighlight | null;
  series: DashboardSeriesPoint[];
}

/**
 * Cliente agregado a partir dos pedidos da loja
 * (GET /api/customers/history).
 *
 * A chave `key` identifica o cliente dentro do estabelecimento: telefone
 * normalizado quando existe, senão o nome normalizado. Pedidos cancelados não
 * entram em `totalOrders`/`totalSpent`/`averageTicket`.
 */
export interface CustomerSummary {
  key: string;
  name: string;
  /** Telefone somente com dígitos (como salvo em `orders.customer_phone`). */
  phone: string | null;
  /** Pedidos válidos (não cancelados). */
  totalOrders: number;
  /** Pedidos com status `finalizado`. */
  completedOrders: number;
  /** Pedidos cancelados (informativos, não somam faturamento). */
  canceledOrders: number;
  /** Soma de `total` dos pedidos não cancelados. */
  totalSpent: number;
  /** Ticket médio dos pedidos não cancelados. */
  averageTicket: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

/** Pedido exibido no histórico completo do cliente (modal). */
export interface CustomerOrderHistory {
  id: string;
  total: number;
  status: OrderStatus;
  created_at: string;
  items: PanelOrderItem[];
  coupon_code?: string | null;
  coupon_discount?: number | null;
}

/** Cliente + histórico completo (GET /api/customers/history?key=...). */
export interface CustomerHistory extends CustomerSummary {
  orders: CustomerOrderHistory[];
}





