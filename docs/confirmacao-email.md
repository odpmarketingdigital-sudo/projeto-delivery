# Confirmação de e-mail no cadastro

Fluxo que impede o acesso ao painel antes de o lojista clicar no link de
confirmação enviado pelo Supabase Auth.

## 1. Configuração no Supabase

1. **Authentication → Sign In / Providers → Email**
   - *Confirm email*: **ligado** (é o que gera `email_confirmed_at` nulo até o
     clique no link);
   - *Secure email change*: recomendado.
2. **Authentication → URL Configuration**
   - *Site URL*: `https://ipepper.com.br`;
   - *Redirect URLs*: inclua `http://localhost:3000/**` e
     `https://ipepper.com.br/auth/callback` (o link do e-mail volta para
     `/auth/callback`).
3. **SMTP próprio** (ou Resend configurado em *Project Settings → Auth*): sem
   SMTP customizado o Supabase limita o envio de confirmações a poucos e-mails
   por hora.
4. **Templates de e-mail** → *Confirm signup*: use o formato `token_hash`, que
   funciona mesmo quando o link é aberto em outro navegador (o fluxo PKCE por
   `?code=` exige o cookie do navegador que fez o cadastro):

   ```html
   <h2>Confirme seu e-mail</h2>
   <p>Falta pouco para liberar o painel do Ipepper.</p>
   <p>
     <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup&next=/painel">
       Confirmar e-mail
     </a>
   </p>
   ```

   O `/auth/callback` valida o token (`verifyOtp`), grava a sessão nos cookies e
   redireciona para `next` (padrão `/painel`). Links expirados/reutilizados caem
   em `/confirmar-email?erro=link-invalido`.

> Em `next dev` o `{{ .SiteURL }}` continua apontando para o domínio de produção
> cadastrado no Supabase. Para testar localmente, troque temporariamente o
> *Site URL* para `http://localhost:3000` (ou use o `token_hash` manualmente).

## 2. Fluxo do cadastro

```
/cadastro (SignupForm)
   └─ POST /api/signup
        ├─ cria usuário (SEM email_confirm) + establishment em trial
        ├─ dispara o e-mail de confirmação (lib/supabase/confirmation.ts) → link com token_hash
        └─ 201 { establishment, email_confirmation_required: true }

   ├─ email_confirmation_required = true  → /confirmar-email?email=…
   └─ email_confirmation_required = false → login automático + /painel
```

`app/api/signup/route.ts` **não** envia mais `email_confirm: true`. Consequências:

- projeto com confirmação obrigatória → conta nasce pendente e o `resend`
  envia o link;
- projeto sem confirmação obrigatória → o GoTrue já confirma na criação, nada é
  enviado e o cliente faz `signInWithPassword` como antes.

## 3. Bloqueios

| Camada | Arquivo | Regra |
| --- | --- | --- |
| Servidor (todas as rotas `/painel*`) | `lib/supabase/middleware.ts` | `getUser().email_confirmed_at` nulo → redirect `/confirmar-email`; `/login` e `/cadastro` com sessão pendente também vão para lá; sessão confirmada em `/confirmar-email` volta para `/painel` |
| Estado no cliente | `context/AuthContext.tsx` | expõe `emailConfirmed` (`true`/`false`/`undefined`), consultando `GET /api/auth/confirmation` quando o JWT não traz `email_confirmed_at` |
| Cliente (dentro do painel) | `app/painel/PainelGuard.tsx` | `currentUser.emailConfirmed === false` → tela de bloqueio + `router.replace("/confirmar-email")` |
| Login | `app/login/page.tsx` | erro `email_not_confirmed` → mensagem + atalho para `/confirmar-email`; sessão criada sem confirmação é encerrada |

`emailConfirmed` é exposto pelo `AuthContext` como `true` / `false` /
`undefined` (não apurado). Como o GoTrue **omite** `email_confirmed_at` quando a
conta está pendente, o contexto consulta `GET /api/auth/confirmation` (servidor,
`getUser()`) sempre que o dado local é desconhecido; assim o `PainelGuard`
consegue redirecionar no cliente, e o middleware continua sendo a fonte da
verdade.

## 4. Tela `/confirmar-email`

`app/confirmar-email/page.tsx` + `ConfirmEmailPanel.tsx`:

- mensagem "Por favor, confirme o seu e-mail antes de acessar o painel";
- campo de e-mail pré-preenchido com `?email=`;
- **Reenviar e-mail de confirmação** → `POST /api/auth/resend-confirmation`
  (envio no servidor, ver §5). Em caso de sucesso o botão entra em contagem
  regressiva (`Aguarde 60s para reenviar`);
- **Já confirmei** → `refreshSession()` + `getUser()`. Confirmado: vai para
  `/painel`; sem sessão no navegador: vai para `/login`;
- erros tratados: `429` (rate limit — "Aguarde 1 minuto antes de solicitar um
  novo e-mail"), `email_already_confirmed`, e-mail sem conta, falha de envio e
  link inválido (`?erro=link-invalido`).

## 5. `POST /api/auth/resend-confirmation`

`app/api/auth/resend-confirmation/route.ts` + `lib/supabase/confirmation.ts`.

O reenvio **não** é feito mais pelo navegador (`supabase.auth.resend`): ele
esbarrava em CORS/bloqueadores e devolvia o erro cru do GoTrue, deixando a tela
sem mensagem. A rota usa a service role (`createAdminClient()` →
`adminClient.auth.resend`) e devolve tudo já traduzido:

| Situação | HTTP | `code` | Mensagem |
| --- | --- | --- | --- |
| E-mail enviado | 200 | — | "Enviamos um novo link de confirmação para …" + `retry_after` |
| E-mail inválido/ausente | 400 | `invalid_email` / `invalid_body` | "Informe o e-mail usado no cadastro." |
| Conta inexistente | 404 | `user_not_found` | "Não encontramos uma conta com este e-mail…" |
| Já confirmado | 409 | `already_confirmed` | "Este e-mail já está confirmado…" |
| Rate limit (Supabase ou cooldown) | 429 | `rate_limited` | "Aguarde 1 minuto antes de solicitar um novo e-mail" + header `Retry-After` |
| Falha de SMTP/provedor | 502 | `send_failed` | "Não foi possível enviar o e-mail de confirmação agora…" |
| Envio desativado no projeto | 503 | `email_disabled` | "O envio de e-mails de confirmação está desativado…" |

Detalhes:

- **Cooldown de 60 s por e-mail** (`CONFIRMATION_RESEND_COOLDOWN_SECONDS`), em
  memória, antes de gastar uma requisição no GoTrue. É *best effort*: com várias
  instâncias o mapa é por processo — o rate limit do Supabase continua sendo a
  proteção definitiva.
- O GoTrue responde 429 com `For security purposes, you can only request this
  after N seconds.`; a rota extrai o `N` e o devolve em `retry_after`, então o
  botão mostra exatamente quanto falta.
- O `emailRedirectTo` é montado por `buildEmailConfirmationRedirect(origem)`
  → `<origem>/auth/callback?next=/painel`, com a origem vinda de
  `getRequestOrigin(request)` e fallback em `NEXT_PUBLIC_APP_URL`.
- `/api/signup` usa a **mesma** função (`resendSignupConfirmation`) logo após
  criar a conta pendente, então cadastro e reenvio nunca divergem.

## 6. Checklist de teste

1. `npm run dev`, cadastre uma loja nova → deve cair em `/confirmar-email`
   (sem sessão) e receber o e-mail "Confirm signup".
2. Acessar `/painel` direto → volta para `/confirmar-email`.
3. Clicar no link do e-mail → `/auth/callback` grava a sessão e abre `/painel`.
4. Tentar login antes de confirmar → "Confirme o seu e-mail antes de acessar o
   painel" + botão de reenvio.
5. Reenviar duas vezes seguidas → a segunda chamada recebe `429` com "Aguarde 1
   minuto antes de solicitar um novo e-mail" e o botão fica em contagem
   regressiva (`Aguarde 59s para reenviar`).
6. Testar a rota isolada:

   ```bash
   curl -i -X POST http://localhost:3000/api/auth/resend-confirmation \
     -H 'Content-Type: application/json' \
     -d '{"email":"loja@exemplo.com"}'
   ```

   Esperado: `200` com `retry_after: 60`; repetindo na sequência, `429` com
   header `Retry-After`.
