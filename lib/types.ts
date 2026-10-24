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
  complement?: string;
  reference?: string;
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
   * Quando vazio/null, a vitrine exibe o badge "DELIVERY" como fallback.
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
  /** true = obrigatório (precisa ser selecionado); false = opcional. */
  is_required: boolean;
  /** false = opcional pausado (não exibido no cardápio). */
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





