/* eslint-disable @next/next/no-head-element, @next/next/no-img-element --
 * Este módulo gera HTML para clientes de e-mail (Gmail, Outlook), não para o
 * Next.js: `<head>` e `<img>` são obrigatórios e as regras `next/head` e
 * `next/image` não se aplicam — e o HTML só é renderizado no servidor
 * (`renderToStaticMarkup`), fora do React do navegador. */
import type { CSSProperties, ReactNode } from "react";

/**
 * Template HTML do e-mail de boas-vindas do Ipepper.
 *
 * Identidade visual: fundo escuro (`#07090c`), faixa amarela/azul no topo do
 * cartão, CTA amarelo e destaques em azul — os mesmos tokens usados no
 * cadastro (`app/cadastro/page.tsx`).
 *
 * ⚠️ Regras de e-mail (diferentes do site):
 *  - Todo o CSS é inline (`style`) e o layout usa tabelas: Gmail e Outlook
 *    descartam `<style>` e boa parte do CSS moderno (flex/grid).
 *  - O CSS é escrito em TSX (objetos `CSSProperties`) e convertido em HTML por
 *    `renderToStaticMarkup` em `renderWelcomeEmail`.
 *  - Este módulo é server-only: `react-dom/server` não roda no cliente.
 */

/** Paleta do e-mail (fundo escuro + amarelo/azul do Ipepper). */
const COLORS = {
  page: "#07090c",
  card: "#0f1218",
  border: "#1f2733",
  heading: "#f8fafc",
  body: "#b7c2d1",
  muted: "#8592a5",
  mutedFaint: "#5f6b7c",
  yellow: "#facc15",
  yellowSoft: "rgba(250, 204, 21, 0.08)",
  yellowBorder: "rgba(250, 204, 21, 0.30)",
  yellowText: "#fde68a",
  blue: "#3b82f6",
  blueSoft: "rgba(59, 130, 246, 0.14)",
  blueBorder: "rgba(59, 130, 246, 0.35)",
  blueText: "#93c5fd",
  buttonText: "#0b0d11",
} as const;

/** Pilha de fontes segura para clientes de e-mail. */
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Dados usados pelo template (já resolvidos por `lib/email/welcome.ts`). */
export interface WelcomeEmailProps {
  /** Nome do responsável pela loja (usado no "Olá"). */
  ownerName: string;
  /** Nome do estabelecimento recém-criado. */
  establishmentName: string;
  /** Link do painel administrativo (`/painel`). */
  panelUrl: string;
  /** Link do cardápio público; `null` quando o slug não é conhecido. */
  menuUrl: string | null;
  /** URL absoluta do logotipo (nunca relativa). */
  logoUrl: string;
  /** Duração do teste grátis, em dias. */
  trialDays: number;
  /** Fim do trial já formatado (ex.: "10 de dezembro de 2026"). */
  trialEndsAtLabel: string | null;
  /** Atalhos do painel usados nas dicas iniciais. */
  productsUrl: string;
  settingsUrl: string;
  subscriptionUrl: string;
  /** E-mail de suporte (vira o "Responda para" do rodapé). */
  supportEmail: string | null;
  /** URL pública da plataforma (links de marca no rodapé). */
  appUrl: string;
  /** Ano corrente, para o copyright. */
  year: number;
}

/** E-mail pronto para envio (mesmo formato aceito pelo Resend). */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Primeiro nome do responsável, com fallback amigável. */
function firstNameOf(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] || "chef";
}

/** `ipepper.com.br/loja` → "ipepper.com.br/loja" (sem protocolo). */
function withoutProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Assunto do e-mail (sem emoji, para não piorar a entregabilidade). */
export function welcomeEmailSubject(ownerName: string): string {
  return `Bem-vindo ao Ipepper, ${firstNameOf(ownerName)}! Sua loja já está no ar`;
}

/** Versão texto puro — alternativa para clientes que bloqueiam HTML. */
export function welcomeEmailText(props: WelcomeEmailProps): string {
  const firstName = firstNameOf(props.ownerName);
  const trial = props.trialEndsAtLabel
    ? `Seu teste gratuito vai até ${props.trialEndsAtLabel} (${props.trialDays} dias), sem cartão de crédito.`
    : `Você tem ${props.trialDays} dias de teste gratuito, sem cartão de crédito.`;

  const lines = [
    `Olá, ${firstName}!`,
    "",
    `A conta do estabelecimento "${props.establishmentName}" foi criada com sucesso e o seu painel no Ipepper já está liberado.`,
    "",
    trial,
    "",
    `Acessar Meu Painel: ${props.panelUrl}`,
    props.menuUrl ? `Seu cardápio público: ${props.menuUrl}` : "",
    "",
    "PARA COMEÇAR BEM",
    `1. Cadastre seus produtos: ${props.productsUrl}`,
    `2. Configure o WhatsApp e as taxas de entrega: ${props.settingsUrl}`,
    `3. Escolha seu plano: ${props.subscriptionUrl}`,
    "",
    props.supportEmail
      ? `Ficou com alguma dúvida? Responda este e-mail ou escreva para ${props.supportEmail}.`
      : "Ficou com alguma dúvida? Responda este e-mail — a gente ajuda você a colocar a loja pra vender.",
    "",
    `Ipepper — cardápio digital e delivery (${props.appUrl})`,
    `Você recebeu este e-mail porque criou uma conta em ${withoutProtocol(props.appUrl)}.`,
    `© ${props.year} Ipepper. Todos os direitos reservados.`,
  ];

  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

/** Dica exibida na lista "Para começar bem". */
interface Tip {
  step: string;
  title: string;
  description: string;
  action: string;
  href: string;
}

/** Selo/pílula usada no topo do cartão. */
function Badge({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    display: "inline-block",
    padding: "6px 12px",
    borderRadius: "999px",
    backgroundColor: COLORS.blueSoft,
    border: `1px solid ${COLORS.blueBorder}`,
    color: COLORS.blueText,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  };

  return <span style={style}>{children}</span>;
}

/**
 * E-mail de boas-vindas (HTML completo, pronto para o Resend).
 *
 * A estrutura de tabelas é intencional: é o layout que o Outlook (engine do
 * Word) renderiza sem quebrar.
 */
export function WelcomeEmail(props: WelcomeEmailProps) {
  const firstName = firstNameOf(props.ownerName);
  const menuLabel = props.menuUrl ? withoutProtocol(props.menuUrl) : null;

  const trialLine = props.trialEndsAtLabel
    ? `Seu teste gratuito vai até ${props.trialEndsAtLabel}, sem cartão de crédito e sem compromisso.`
    : `Você tem ${props.trialDays} dias para testar tudo, sem cartão de crédito e sem compromisso.`;

  const tips: Tip[] = [
    {
      step: "1",
      title: "Cadastre seus produtos",
      description:
        "Crie categorias, envie fotos e defina preços. O cardápio fica pronto em poucos minutos.",
      action: "Ir para produtos",
      href: props.productsUrl,
    },
    {
      step: "2",
      title: "Configure o WhatsApp",
      description:
        "Informe o número que recebe os pedidos e ajuste as taxas e o prazo de entrega.",
      action: "Abrir configurações",
      href: props.settingsUrl,
    },
    {
      step: "3",
      title: "Escolha seu plano",
      description:
        "Garanta que a loja continue vendendo depois do teste, direto pelo painel.",
      action: "Ver planos",
      href: props.subscriptionUrl,
    },
  ];

  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <meta name="supported-color-schemes" content="dark light" />
        <title>{welcomeEmailSubject(props.ownerName)}</title>
      </head>

      <body
        style={{
          margin: 0,
          padding: 0,
          width: "100%",
          backgroundColor: COLORS.page,
          color: COLORS.body,
          fontFamily: FONT_STACK,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        {/* Pré-header: texto exibido na lista de mensagens, antes de abrir. */}
        <div
          style={{
            display: "none",
            maxHeight: 0,
            maxWidth: 0,
            overflow: "hidden",
            opacity: 0,
            fontSize: "1px",
            lineHeight: "1px",
            color: "transparent",
          }}
        >
          {props.establishmentName} está no ar no Ipepper. Acesse o painel e
          comece a receber pedidos hoje.
        </div>

        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          border={0}
          style={{ width: "100%", backgroundColor: COLORS.page }}
        >
          <tbody>
            <tr>
              <td align="center" style={{ padding: "36px 16px 48px" }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  border={0}
                  style={{ width: "100%", maxWidth: "600px" }}
                >
                  <tbody>
                    {/* Cabeçalho — logotipo da marca */}
                    <tr>
                      <td style={{ padding: "0 0 24px" }}>
                        <a
                          href={props.appUrl}
                          style={{ textDecoration: "none", display: "inline-block" }}
                        >
                          <img
                            src={props.logoUrl}
                            alt="Ipepper"
                            width={168}
                            height={78}
                            style={{
                              display: "block",
                              width: "168px",
                              height: "auto",
                              border: 0,
                              outline: "none",
                              textDecoration: "none",
                            }}
                          />
                        </a>
                      </td>
                    </tr>

                    {/* Cartão principal */}
                    <tr>
                      <td
                        style={{
                          backgroundColor: COLORS.card,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: "18px",
                        }}
                      >
                        {/* Faixa amarela + azul no topo do cartão */}
                        <table
                          role="presentation"
                          width="100%"
                          cellPadding={0}
                          cellSpacing={0}
                          border={0}
                          style={{ width: "100%" }}
                        >
                          <tbody>
                            <tr>
                              <td
                                width="62%"
                                height={4}
                                style={{
                                  height: "4px",
                                  backgroundColor: COLORS.yellow,
                                  fontSize: "0",
                                  lineHeight: "0",
                                }}
                              >
                                &nbsp;
                              </td>
                              <td
                                width="38%"
                                height={4}
                                style={{
                                  height: "4px",
                                  backgroundColor: COLORS.blue,
                                  fontSize: "0",
                                  lineHeight: "0",
                                }}
                              >
                                &nbsp;
                              </td>
                            </tr>
                          </tbody>
                        </table>

                        <table
                          role="presentation"
                          width="100%"
                          cellPadding={0}
                          cellSpacing={0}
                          border={0}
                          style={{ width: "100%" }}
                        >
                          <tbody>
                            {/* Boas-vindas */}
                            <tr>
                              <td style={{ padding: "32px 32px 0" }}>
                                <Badge>Bem-vindo ao Ipepper</Badge>

                                <h1
                                  style={{
                                    margin: "20px 0 0",
                                    fontSize: "26px",
                                    lineHeight: "34px",
                                    fontWeight: 800,
                                    letterSpacing: "-0.02em",
                                    color: COLORS.heading,
                                  }}
                                >
                                  Sua loja está no ar, {firstName}.
                                </h1>

                                <p
                                  style={{
                                    margin: "14px 0 0",
                                    fontSize: "15px",
                                    lineHeight: "24px",
                                    color: COLORS.body,
                                  }}
                                >
                                  Que bom ter você por aqui! A conta do{" "}
                                  <strong style={{ color: COLORS.heading }}>
                                    {props.establishmentName}
                                  </strong>{" "}
                                  foi criada com sucesso e o seu painel já está
                                  liberado. Agora é só cadastrar o cardápio e
                                  começar a receber pedidos.
                                </p>
                              </td>
                            </tr>


                            {/* Teste grátis */}
                            <tr>
                              <td style={{ padding: "24px 32px 0" }}>
                                <table
                                  role="presentation"
                                  width="100%"
                                  cellPadding={0}
                                  cellSpacing={0}
                                  border={0}
                                  style={{ width: "100%" }}
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        style={{
                                          backgroundColor: COLORS.yellowSoft,
                                          border: `1px solid ${COLORS.yellowBorder}`,
                                          borderRadius: "12px",
                                          padding: "14px 16px",
                                        }}
                                      >
                                        <p
                                          style={{
                                            margin: 0,
                                            fontSize: "13px",
                                            lineHeight: "20px",
                                            color: COLORS.yellowText,
                                          }}
                                        >
                                          <strong>
                                            {props.trialDays} dias grátis.
                                          </strong>{" "}
                                          {trialLine}
                                        </p>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </td>
                            </tr>

                            {/* CTA principal */}
                            <tr>
                              <td align="center" style={{ padding: "28px 32px 0" }}>
                                <table
                                  role="presentation"
                                  cellPadding={0}
                                  cellSpacing={0}
                                  border={0}
                                >
                                  <tbody>
                                    <tr>
                                      <td
                                        align="center"
                                        style={{
                                          backgroundColor: COLORS.yellow,
                                          borderRadius: "12px",
                                        }}
                                      >
                                        <a
                                          href={props.panelUrl}
                                          style={{
                                            display: "inline-block",
                                            padding: "15px 34px",
                                            borderRadius: "12px",
                                            backgroundColor: COLORS.yellow,
                                            color: COLORS.buttonText,
                                            fontSize: "15px",
                                            fontWeight: 800,
                                            lineHeight: "20px",
                                            textDecoration: "none",
                                          }}
                                        >
                                          Acessar Meu Painel
                                        </a>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>

                                {menuLabel && props.menuUrl ? (
                                  <p
                                    style={{
                                      margin: "14px 0 0",
                                      fontSize: "13px",
                                      lineHeight: "20px",
                                      color: COLORS.muted,
                                    }}
                                  >
                                    Seu cardápio público:{" "}
                                    <a
                                      href={props.menuUrl}
                                      style={{
                                        color: COLORS.blueText,
                                        textDecoration: "underline",
                                      }}
                                    >
                                      {menuLabel}
                                    </a>
                                  </p>
                                ) : null}
                              </td>
                            </tr>


                            {/* Dicas rápidas */}
                            <tr>
                              <td style={{ padding: "32px 32px 0" }}>
                                <p
                                  style={{
                                    margin: 0,
                                    fontSize: "12px",
                                    fontWeight: 700,
                                    letterSpacing: "0.16em",
                                    textTransform: "uppercase",
                                    color: COLORS.muted,
                                  }}
                                >
                                  Para começar bem
                                </p>

                                <table
                                  role="presentation"
                                  width="100%"
                                  cellPadding={0}
                                  cellSpacing={0}
                                  border={0}
                                  style={{ width: "100%", marginTop: "16px" }}
                                >
                                  <tbody>
                                    {tips.map((tip) => (
                                      <tr key={tip.step}>
                                        <td
                                          width={40}
                                          valign="top"
                                          style={{ padding: "0 12px 20px 0" }}
                                        >
                                          <span
                                            style={{
                                              display: "inline-block",
                                              width: "28px",
                                              height: "28px",
                                              lineHeight: "28px",
                                              textAlign: "center",
                                              borderRadius: "9px",
                                              backgroundColor: COLORS.blueSoft,
                                              border: `1px solid ${COLORS.blueBorder}`,
                                              color: COLORS.blueText,
                                              fontSize: "13px",
                                              fontWeight: 800,
                                            }}
                                          >
                                            {tip.step}
                                          </span>
                                        </td>
                                        <td valign="top" style={{ padding: "0 0 20px" }}>
                                          <p
                                            style={{
                                              margin: 0,
                                              fontSize: "14px",
                                              lineHeight: "20px",
                                              fontWeight: 700,
                                              color: COLORS.heading,
                                            }}
                                          >
                                            {tip.title}
                                          </p>
                                          <p
                                            style={{
                                              margin: "4px 0 0",
                                              fontSize: "13px",
                                              lineHeight: "20px",
                                              color: COLORS.body,
                                            }}
                                          >
                                            {tip.description}
                                          </p>
                                          <a
                                            href={tip.href}
                                            style={{
                                              display: "inline-block",
                                              marginTop: "6px",
                                              fontSize: "12px",
                                              fontWeight: 700,
                                              color: COLORS.yellow,
                                              textDecoration: "none",
                                            }}
                                          >
                                            {tip.action} →
                                          </a>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>


                            {/* Divisor */}
                            <tr>
                              <td style={{ padding: "0 32px" }}>
                                <div
                                  style={{
                                    height: "1px",
                                    backgroundColor: COLORS.border,
                                    fontSize: "0",
                                    lineHeight: "0",
                                  }}
                                >
                                  &nbsp;
                                </div>
                              </td>
                            </tr>

                            {/* Suporte */}
                            <tr>
                              <td style={{ padding: "20px 32px 32px" }}>
                                <p
                                  style={{
                                    margin: 0,
                                    fontSize: "13px",
                                    lineHeight: "21px",
                                    color: COLORS.body,
                                  }}
                                >
                                  {props.supportEmail ? (
                                    <>
                                      Ficou com alguma dúvida? Responda este
                                      e-mail ou escreva para{" "}
                                      <a
                                        href={`mailto:${props.supportEmail}`}
                                        style={{
                                          color: COLORS.blueText,
                                          textDecoration: "none",
                                        }}
                                      >
                                        {props.supportEmail}
                                      </a>
                                      .
                                    </>
                                  ) : (
                                    <>
                                      Ficou com alguma dúvida? Responda este
                                      e-mail — a gente ajuda você a colocar a
                                      loja pra vender.
                                    </>
                                  )}
                                </p>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>


                    {/* Rodapé */}
                    <tr>
                      <td align="center" style={{ padding: "24px 8px 0" }}>
                        <p
                          style={{
                            margin: 0,
                            fontSize: "12px",
                            lineHeight: "18px",
                            fontWeight: 700,
                            color: COLORS.muted,
                          }}
                        >
                          Ipepper · Cardápio digital e delivery
                        </p>
                        <p
                          style={{
                            margin: "6px 0 0",
                            fontSize: "12px",
                            lineHeight: "18px",
                            color: COLORS.mutedFaint,
                          }}
                        >
                          Você recebeu este e-mail porque criou uma conta em{" "}
                          <a
                            href={props.appUrl}
                            style={{
                              color: COLORS.muted,
                              textDecoration: "underline",
                            }}
                          >
                            {withoutProtocol(props.appUrl)}
                          </a>
                          .
                        </p>
                        <p
                          style={{
                            margin: "10px 0 0",
                            fontSize: "11px",
                            lineHeight: "16px",
                            color: COLORS.mutedFaint,
                          }}
                        >
                          © {props.year} Ipepper. Todos os direitos reservados.
                        </p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

/** Carregador preguiçoso do renderizador (ver `renderWelcomeEmail`). */
let rendererPromise: Promise<typeof import("react-dom/server")> | null = null;

/**
 * Importa `react-dom/server` em tempo de execução.
 *
 * O Next.js recusa um `import` estático de `react-dom/server` em módulos que
 * fazem parte do grafo do App Router ("You're importing a component that
 * imports react-dom/server"). Como o template só é renderizado dentro de Route
 * Handlers (Node.js), o import dinâmico resolve o módulo na primeira chamada —
 * e fica em cache no processo.
 */
function loadRenderer() {
  rendererPromise ??= import("react-dom/server");
  return rendererPromise;
}

/**
 * Atributos que o React escreve em camelCase e o HTML de e-mail espera em
 * minúsculas (`cellPadding` → `cellpadding`).
 */
const LOWERCASE_ATTRIBUTES: Record<string, string> = {
  charSet: "charset",
  cellPadding: "cellpadding",
  cellSpacing: "cellspacing",
};

/**
 * Ajustes finais no HTML gerado:
 *  - atributos em minúsculas (o HTML é case-insensitive, mas o Outlook antigo
 *    é mais feliz com a forma canônica);
 *  - remove o `<link rel="preload">` que o React 19 injeta para o `<img>` do
 *    cabeçalho — não serve para nada em um e-mail e só aumenta o tamanho.
 */
function normalizeEmailHtml(html: string): string {
  return html
    .replace(/<link rel="preload"[^>]*\/?>/g, "")
    .replace(/\s(charSet|cellPadding|cellSpacing)="/g, (_, name: string) => {
      return ` ${LOWERCASE_ATTRIBUTES[name]}="`;
    });
}

/**
 * Serializa o template em HTML completo (+ assunto e versão texto).
 *
 * `renderToStaticMarkup` (e não `renderToString`) evita os atributos internos
 * do React, deixando o HTML limpo para os clientes de e-mail.
 */
export async function renderWelcomeEmail(
  props: WelcomeEmailProps
): Promise<RenderedEmail> {
  const { renderToStaticMarkup } = await loadRenderer();
  const markup = normalizeEmailHtml(
    renderToStaticMarkup(<WelcomeEmail {...props} />)
  );

  return {
    subject: welcomeEmailSubject(props.ownerName),
    html: `<!DOCTYPE html>\n${markup}`,
    text: welcomeEmailText(props),
  };
}

