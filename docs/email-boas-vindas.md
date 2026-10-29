# E-mail de boas-vindas — cadastro de novas lojas

Enviado automaticamente por `POST /api/signup` quando uma loja é criada:
confirma que a conta está no ar, mostra o cardápio público, o prazo do teste
grátis e os três primeiros passos no painel.

- Template: `lib/email/templates/welcome.tsx` (HTML em tabelas + CSS inline)
- Envio: `lib/email/welcome.ts` (`sendWelcomeEmail`, `sendWelcomeEmailSafely`)
- Cliente Resend: `lib/email/resend.ts` (singleton, `null` sem chave)
- Configuração/links: `lib/email/config.ts`

## 1. Variáveis de ambiente

Em `.env.local` (e no provedor de deploy):

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM="Ipepper <nao-responda@ipepper.com.br>"
EMAIL_REPLY_TO=contato@ipepper.com.br   # opcional
NEXT_PUBLIC_APP_URL=https://ipepper.com.br
EMAIL_LOGO_URL=                          # opcional
```

| Variável | Obrigatória | Efeito |
| --- | --- | --- |
| `RESEND_API_KEY` | para enviar | Sem ela o cadastro **não** envia e-mail: registra `[email/boas-vindas] RESEND_API_KEY ausente` e responde **201** normalmente |
| `EMAIL_FROM` | não | Remetente. Padrão `Ipepper <nao-responda@ipepper.com.br>`; o domínio precisa estar verificado no Resend |
| `EMAIL_REPLY_TO` | não | Vira o *Reply-To* e o contato de suporte no rodapé |
| `NEXT_PUBLIC_APP_URL` | não | Base dos links (painel, cardápio, rodapé). Padrão `https://ipepper.com.br`, sem barra final |
| `EMAIL_LOGO_URL` | não | URL absoluta do logotipo. Padrão `${NEXT_PUBLIC_APP_URL}/logotipo-email.png` |

## 2. Verificar o domínio no Resend

1. Acesse <https://resend.com/domains> → **Add Domain** e informe
   `ipepper.com.br`.
2. Copie os registros DNS exibidos (**SPF/TXT**, **DKIM** e, se aparecer,
   **DMARC**) para o provedor do domínio.
3. Aguarde o status **Verified** (normalmente minutos; o DKIM pode levar horas).
4. Só então use um remetente desse domínio em `EMAIL_FROM`.

Sem a verificação o Resend recusa o envio (`domain is not verified`) e o log do
`next dev` mostra `[email/boas-vindas] falha ao enviar …`. Para testes rápidos é
possível usar `EMAIL_FROM="Ipepper <onboarding@resend.dev>"` (remetente de
teste, que só entrega para o e-mail dono da conta Resend).

## 3. O que o e-mail contém

| Bloco | Conteúdo |
| --- | --- |
| Pré-header | Texto da prévia na caixa de entrada |
| Cartão | Selo "Bem-vindo ao Ipepper", título com o primeiro nome do responsável e o nome da loja |
| Teste grátis | `30 dias grátis` + data final (`trial_ends_at` em pt-BR, fuso de Brasília) |
| CTA | Botão amarelo **Acessar Meu Painel** (`/painel`) e link do cardápio (`/<slug>`) |
| Dicas | 1. Produtos · 2. WhatsApp/configurações · 3. Planos |
| Suporte | `EMAIL_REPLY_TO` (ou convite para responder o e-mail) |
| Rodapé | Marca, motivo do envio e copyright |

O assunto é `Bem-vindo ao Ipepper, <primeiro nome>! Sua loja já está no ar`
(sem emoji, para não piorar a entregabilidade). Também é gerada uma versão
**texto puro** para clientes que bloqueiam HTML.

## 4. Comportamento em caso de falha

O envio é *best effort*: a conta no Supabase Auth e a linha em
`establishments` já foram criadas antes do disparo. Qualquer erro do provedor é
apenas registrado no console (`[email/boas-vindas] …`) e o cadastro continua
respondendo **201** — o lojista entra no painel e vê o trial ativo de qualquer
forma.

> **Confirmação de e-mail:** o acesso ao painel depende do clique no link de
> confirmação enviado pelo **Supabase**, que é outro e-mail (independente deste).
> Com a opção "Confirm email" ativa no projeto, o lojista só entra depois de
> confirmar — ver [`docs/confirmacao-email.md`](./confirmacao-email.md).

Resultados possíveis de `sendWelcomeEmail` (`lib/email/welcome.ts`):

| `status` | Quando |
| --- | --- |
| `sent` | Resend aceitou a mensagem (devolve o `id`) |
| `skipped` / `not-configured` | `RESEND_API_KEY` ausente |
| `skipped` / `invalid-recipient` | E-mail do cadastro fora do padrão |
| `failed` | Erro da API ou de rede (mensagem no campo `error`) |

## 5. Pré-visualizar o layout

Com o `next dev` rodando:

```bash
# HTML completo do e-mail com dados de exemplo
curl -s "http://localhost:3000/api/email/preview" > /tmp/email.html

# Dados personalizados (nome do responsável, loja e slug)
curl -s "http://localhost:3000/api/email/preview?nome=Maria%20Silva&loja=Maria%20Burgers&slug=maria-burgers" \
  > /tmp/email.html

# Versão texto puro (clientes que bloqueiam HTML)
curl -s "http://localhost:3000/api/email/preview?formato=texto"
```

Abre o arquivo no navegador (`/tmp/email.html`) para revisar. O assunto fica no
header `X-Email-Subject` (URL-encoded). A rota responde **404** em produção.

## 6. Detalhes de implementação

- O template é TSX (objetos `React.CSSProperties` → CSS inline), mas **não**
  faz parte do React do App Router: ele é serializado com
  `renderToStaticMarkup` dentro de Route Handlers.
- O Next.js bloqueia `import` estático de `react-dom/server` no grafo do App
  Router (`You're importing a component that imports react-dom/server`). Por
  isso `lib/email/templates/welcome.tsx` carrega o renderizador com
  `await import("react-dom/server")` na primeira chamada
  (`renderWelcomeEmail` é **assíncrono**).
- Depois de renderizar, `normalizeEmailHtml` deixa os atributos em minúsculas
  (`cellpadding`) e remove o `<link rel="preload">` que o React 19 injeta para
  o `<img>` do cabeçalho.
- As regras `@next/next/no-head-element` e `@next/next/no-img-element` ficam
  desligadas no topo do arquivo: `<head>` e `<img>` são obrigatórios em e-mail.
- O logotipo do cabeçalho é `public/logotipo-email.png` (480×223, fundo
  transparente), rasterizado do `public/logotipo.svg` com:

  ```bash
  magick -background none -density 200 public/logotipo.svg -resize 480x \
    -strip PNG32:public/logotipo-email.png
  ```

  PNG (e não WebP/SVG) porque o Outlook para Windows não renderiza WebP e o
  Gmail bloqueia SVG. O template exibe em `168px` (`width`/`height` fixos para
  reservar o espaço e evitar salto de layout).

## 7. Checklist antes de publicar

1. `RESEND_API_KEY`, `EMAIL_FROM` e `NEXT_PUBLIC_APP_URL` definidos no deploy.
2. Domínio verificado no Resend.
3. `npx tsc --noEmit` e `npx eslint .` sem erros.
4. Cadastro de teste em `/cadastro` → conferir o e-mail recebido e o link do
   cardápio (`https://ipepper.com.br/<slug>`).
