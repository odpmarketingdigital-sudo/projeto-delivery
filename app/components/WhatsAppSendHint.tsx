/**
 * Destaque exibido logo acima do botão que envia o pedido no WhatsApp.
 *
 * O pedido já é gravado no painel da loja — o botão é apenas o atalho para
 * mandar o resumo. Como boa parte dos clientes para na tela de confirmação sem
 * clicar, o aviso usa texto em negrito + seta com pulso suave para puxar o
 * olhar. As animações são desligadas quando o sistema pede menos movimento
 * (`motion-reduce`), seguindo o restante da plataforma.
 */
export function WhatsAppSendHint({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-1 text-center ${className}`}
    >
      <p className="text-sm font-bold leading-snug text-emerald-700 dark:text-emerald-300 md:text-base">
        <span aria-hidden="true">👇 </span>
        Clique no botão abaixo para enviar seu pedido no WhatsApp
      </p>
      <span
        aria-hidden="true"
        className="animate-bounce text-lg leading-none text-emerald-600 motion-reduce:animate-none dark:text-emerald-400"
      >
        ↓
      </span>
    </div>
  );
}
