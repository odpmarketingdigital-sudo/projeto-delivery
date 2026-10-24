"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Caminho público do MP3 do alerta. O arquivo vive em
 * `public/sound/sound.mp3` e é servido pela raiz (`/sound/sound.mp3`).
 */
export const NEW_ORDER_SOUND_SRC = "/sound/sound.mp3";

const ENABLE_ERROR = "Não foi possível ativar o som. Tente novamente.";
const RELEASE_ERROR = "Clique em Ativar som para liberar o áudio novamente.";
const LOAD_ERROR = `Não foi possível carregar ${NEW_ORDER_SOUND_SRC}.`;
const PLAY_ERROR = "Não foi possível tocar o alerta sonoro. Tente novamente.";

/** Cria o elemento de áudio já apontando para o MP3 do alerta. */
function createAlertAudio(): HTMLAudioElement {
  const audio = new Audio(NEW_ORDER_SOUND_SRC);
  // `auto` deixa o MP3 em memória, então o primeiro pedido toca sem atraso.
  audio.preload = "auto";
  audio.volume = 1;
  return audio;
}

/**
 * Reinicia o MP3 para que o alerta sempre comece do início, inclusive quando
 * um pedido novo chega enquanto o som anterior ainda está tocando.
 */
function restartAudio(audio: HTMLAudioElement): void {
  try {
    audio.currentTime = 0;
  } catch {
    // Alguns navegadores lançam se os metadados ainda não chegaram; nesse
    // caso o próprio `play()` já inicia a reprodução do começo.
  }
}

/** Extrai o `name` de um DOMException/Error para diferenciar as falhas. */
function getErrorName(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("name" in err)) return null;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/** Traduz a falha do `play()` em uma mensagem para o operador. */
function playbackErrorMessage(err: unknown): string {
  const name = getErrorName(err);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return RELEASE_ERROR;
  }
  if (name === "NotSupportedError") return LOAD_ERROR;
  return PLAY_ERROR;
}

export interface UseOrderSoundResult {
  /** O áudio já foi liberado por um gesto do usuário. */
  isEnabled: boolean;
  /** O operador silenciou o alerta depois de ativá-lo. */
  isMuted: boolean;
  /** Mensagem exibida quando o navegador bloqueia ou não suporta áudio. */
  error: string | null;
  enableSound: () => Promise<void>;
  toggleMuted: () => void;
  /** Toca o MP3 somente se o som estiver ativo e desmutado. */
  playNewOrderSound: () => void;
}

/**
 * Alerta sonoro de novos pedidos baseado em um `HTMLAudioElement` que carrega
 * `public/sound/sound.mp3`.
 *
 * Os navegadores bloqueiam áudio até um gesto do usuário. Por isso o elemento
 * só recebe um `play()` de verdade dentro de `enableSound`, chamado pelo botão
 * "Ativar som" — o próprio som serve de confirmação de que o alerta está
 * armado. Depois disso, `playNewOrderSound` é estável (usa refs) e pode ser
 * chamado pelo polling/Realtime sem recriar efeitos.
 */
export function useOrderSound(): UseOrderSoundResult {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Refs espelham o estado para que a função de play seja estável e leia
  // sempre o valor mais recente, mesmo dentro de callbacks assíncronos.
  const enabledRef = useRef(false);
  const mutedRef = useRef(false);

  /** Cria o elemento no cliente (uma única vez) ao primeiro uso. */
  const getAudio = useCallback((): HTMLAudioElement | null => {
    if (typeof window === "undefined") return null;
    if (!audioRef.current) {
      audioRef.current = createAlertAudio();
    }
    return audioRef.current;
  }, []);

  const markSoundUnavailable = useCallback((message: string) => {
    enabledRef.current = false;
    mutedRef.current = false;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      restartAudio(audio);
    }
    setIsEnabled(false);
    setIsMuted(false);
    setError(message);
  }, []);

  useEffect(() => {
    // Cria o elemento já na montagem para pré-carregar o MP3 (`preload`).
    getAudio();

    return () => {
      const audio = audioRef.current;
      audioRef.current = null;
      enabledRef.current = false;
      mutedRef.current = false;
      if (!audio) return;
      audio.pause();
      // Libera o buffer do arquivo quando o operador sai do painel.
      audio.removeAttribute("src");
      audio.load();
    };
  }, [getAudio]);

  const enableSound = useCallback(async () => {
    const audio = getAudio();
    if (!audio) {
      setError("Este navegador não oferece suporte a áudio.");
      return;
    }

    try {
      // O `play()` precisa acontecer DENTRO do clique para desbloquear o
      // elemento; depois o navegador libera as reproduções automáticas.
      restartAudio(audio);
      await audio.play();

      enabledRef.current = true;
      mutedRef.current = false;
      setIsEnabled(true);
      setIsMuted(false);
      setError(null);
    } catch {
      enabledRef.current = false;
      mutedRef.current = false;
      setIsEnabled(false);
      setIsMuted(false);
      setError(ENABLE_ERROR);
    }
  }, [getAudio]);

  const toggleMuted = useCallback(() => {
    if (!enabledRef.current) return;
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setIsMuted(nextMuted);

    // Silenciar também interrompe um alerta que esteja tocando agora.
    if (nextMuted) audioRef.current?.pause();
  }, []);

  const playNewOrderSound = useCallback(() => {
    if (!enabledRef.current || mutedRef.current) return;

    const audio = audioRef.current;
    if (!audio) {
      markSoundUnavailable(RELEASE_ERROR);
      return;
    }

    // Sempre do início: evita que um alerta disparado em sequência fique mudo
    // porque o arquivo já chegou ao fim (ou está no meio da reprodução).
    restartAudio(audio);

    let playPromise: Promise<void> | undefined;
    try {
      playPromise = audio.play();
    } catch (err) {
      markSoundUnavailable(playbackErrorMessage(err));
      return;
    }

    void playPromise?.catch((err: unknown) => {
      // `AbortError` acontece quando o operador silencia no meio da reprodução
      // ou quando um novo `play()` substitui o anterior: não é uma falha real.
      if (getErrorName(err) === "AbortError") return;
      if (!enabledRef.current) return;
      markSoundUnavailable(playbackErrorMessage(err));
    });
  }, [markSoundUnavailable]);

  return {
    isEnabled,
    isMuted,
    error,
    enableSound,
    toggleMuted,
    playNewOrderSound,
  };
}

