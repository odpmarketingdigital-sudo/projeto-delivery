import { PedidoTracker } from "./PedidoTracker";

/**
 * Página de Acompanhamento do Pedido (Server Component).
 *
 * Exporta `instant = false` porque depende do id dinâmico da rota e de dados
 * dinâmicos no cliente (a interatividade vive em <PedidoTracker>).
 */
export const instant = false;

export default async function PedidoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PedidoTracker orderId={id} />;
}
