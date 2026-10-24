"use client";

interface OrderSoundControlProps {
  isEnabled: boolean;
  isMuted: boolean;
  error: string | null;
  onEnable: () => Promise<void>;
  onToggleMute: () => void;
}

function SpeakerOnIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="m22 9-6 6" />
      <path d="m16 9 6 6" />
    </svg>
  );
}

/**
 * Botão de ativação/mute do alerta de novos pedidos.
 *
 * Antes da ativação, o botão fica destacado em amarelo e explica a ação
 * necessária (gesto do usuário para liberar o autoplay). Depois disso, vira um
 * controle compacto de som ligado/silenciado, sempre visível no cabeçalho.
 */
export function OrderSoundControl({
  isEnabled,
  isMuted,
  error,
  onEnable,
  onToggleMute,
}: OrderSoundControlProps) {
  const label = !isEnabled ? "Ativar som" : isMuted ? "Sem som" : "Som ligado";
  const ariaLabel = !isEnabled
    ? "Ativar alerta sonoro de novos pedidos"
    : isMuted
      ? "Alerta sonoro silenciado. Reativar som de novos pedidos"
      : "Alerta sonoro ativado. Silenciar som de novos pedidos";

  const colorClass = !isEnabled
    ? "border-yellow-400/40 bg-yellow-400/10 text-yellow-200 hover:bg-yellow-400/15"
    : isMuted
      ? "border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          if (isEnabled) {
            onToggleMute();
          } else {
            void onEnable();
          }
        }}
        aria-label={ariaLabel}
        title={error ?? ariaLabel}
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-yellow-400/50 ${colorClass}`}
      >
        {isEnabled && !isMuted ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
        <span>{label}</span>
      </button>
      {error && (
        <span
          role="alert"
          className="max-w-[220px] text-[11px] leading-snug text-red-300"
        >
          {error}
        </span>
      )}
    </div>
  );
}
