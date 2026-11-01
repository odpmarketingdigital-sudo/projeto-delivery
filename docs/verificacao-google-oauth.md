# Verificação de marca no Google Cloud (OAuth) — ipepper

Checklist para publicar a tela de consentimento OAuth em produção e passar na
verificação de marca do Google, usando as páginas institucionais que existem
neste repositório:

| Recurso | Rota | URL pública |
| --- | --- | --- |
| Página inicial | `app/page.tsx` | `https://www.ipepper.com.br/` |
| Política de Privacidade | `app/privacidade/page.tsx` | `https://www.ipepper.com.br/privacidade` |
| Termos de Uso | `app/termos/page.tsx` | `https://www.ipepper.com.br/termos` |
| `robots.txt` | `app/robots.ts` | `https://www.ipepper.com.br/robots.txt` |
| `sitemap.xml` | `app/sitemap.ts` | `https://www.ipepper.com.br/sitemap.xml` |

As três páginas são estáticas (`○ (Static)` no `next build`), respondem `200`
sem sessão/cookies e não passam por nenhum redirecionamento de autenticação —
o middleware só protege `/painel`, `/login`, `/cadastro` e o onboarding.

---

## 1. Deploy (Vercel ou equivalente)

1. **Build command:** `npm run build` — **Output:** `.next` (detecção automática
   do Next.js). Node 20+.
2. **Variáveis de ambiente** (Production): todas as de `.env.local.example`
   (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ASAAS_*`, `RESEND_API_KEY`, `EMAIL_FROM`) mais:
   - `NEXT_PUBLIC_SITE_URL=https://www.ipepper.com.br` — alimenta `canonical`,
     Open Graph, `robots.txt` e `sitemap.xml`.
   - `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` — opcional (ver passo 3).
3. **Domínio único com `www`:** em *Project → Settings → Domains*, adicione
   `www.ipepper.com.br` como principal e `ipepper.com.br` com **Redirect 301**
   para o `www` (ou o contrário — o importante é que apenas **um** responda
   `200` e o outro redirecione). Certificado TLS é emitido automaticamente.
4. **Sem `noindex`/proteção de deployment:** a Vercel Deployment Protection
   precisa ficar desligada para Production; caso contrário o Google recebe
   `401` e reprova a URL da política.

Após o deploy, valide:

```bash
curl -sI https://www.ipepper.com.br/privacidade | head -1   # HTTP/2 200
curl -sI https://www.ipepper.com.br/termos      | head -1   # HTTP/2 200
curl -s  https://www.ipepper.com.br/robots.txt              # Sitemap: .../sitemap.xml
curl -s  https://www.ipepper.com.br/sitemap.xml             # /, /privacidade, /termos
```

Confirme também em uma janela anônima (sem sessão) que as páginas abrem,
mostram `contato@ipepper.com.br`, `(17) 99265-0646` e o link de volta para o
início — o revisor do Google abre exatamente assim.

---

## 2. Google Search Console (comprovar a posse do domínio)

O Google exige o domínio verificado **na mesma conta** que publica o app.

**Opção A — Propriedade de domínio (recomendada):** adicione `ipepper.com.br`
como *Domain property* e crie o registro `TXT` no DNS (`@` →
`google-site-verification=...`). Cobre `www` e apex de uma vez.

**Opção B — Prefixo de URL (`https://www.ipepper.com.br`):** escolha
*Verificação por tag HTML*, copie o `content="..."` e defina
`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` na Vercel. O `app/layout.tsx` injeta
`<meta name="google-site-verification" content="...">` em todas as páginas.
Faça o redeploy e clique em *Verificar*.

Depois da verificação, envie `https://www.ipepper.com.br/sitemap.xml` em
*Sitemaps* e use *Inspeção de URL* → *Solicitar indexação* nas duas páginas
legais (agiliza a leitura pelo revisor).

---

## 3. Tela de consentimento OAuth (Google Cloud Console)

*APIs & Services → OAuth consent screen* (versão nova: *Google Auth Platform →
Branding / Audience / Data access*).

**Branding**

| Campo | Valor |
| --- | --- |
| App name | `ipepper` (sem "Google", sem "App", ≤ 30 caracteres) |
| User support email | `contato@ipepper.com.br` (e-mail da própria conta, verificado) |
| App logo | PNG/JPG quadrado 120×120 (logo do `public/logotipo.png`) |
| Application home page | `https://www.ipepper.com.br` |
| Application privacy policy link | `https://www.ipepper.com.br/privacidade` |
| Application terms of service link | `https://www.ipepper.com.br/termos` |
| Authorized domains | `ipepper.com.br` |
| Developer contact information | `contato@ipepper.com.br` |

Regras que reprovam a análise com mais frequência:

- o nome do app **não aparece** na home nem nas páginas legais;
- a URL da política abre **login**, `404`, `403` (Deployment Protection) ou
  redireciona para outro domínio;
- o domínio não está verificado no Search Console com a mesma conta;
- a política é genérica, sem citar coleta de dados, finalidade,
  compartilhamento (Stripe/Asaas), direitos do titular e contato;
- e-mail de suporte é `gmail.com`/`hotmail.com` em vez de domínio próprio.

**Audience:** `External` → *Publish app* (status **In production**). Em
*Testing* o refresh token expira em 7 dias e o app não é aprovado.

**Data access (escopos):** mantenha apenas os básicos —

```
openid
.../auth/userinfo.email
.../auth/userinfo.profile
```

Esses três são *non-sensitive*: a publicação é imediata, sem auditoria. Escopos
sensíveis/restritos (`gmail.readonly`, `drive`, `calendar`, ...) exigem
justificativa em vídeo e, nos restritos, avaliação de segurança paga — não é o
caso deste app, que só usa o e-mail/nome do Google para criar a conta.

---

## 4. Cliente OAuth (redirect URIs)

*APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)*.

O login deste projeto **não** volta direto do Google para o app: o
`supabase.auth.signInWithOAuth` (`app/components/GoogleAuthButton.tsx`) usa o
Supabase como intermediário, com retorno em
`https://www.ipepper.com.br/auth/callback?next=...`.

| Onde | URI |
| --- | --- |
| *Authorized redirect URIs* (Google) | `https://<PROJECT-REF>.supabase.co/auth/v1/callback` |
| *Authorized JavaScript origins* (Google) | `https://www.ipepper.com.br` |
| Supabase → *Authentication → URL Configuration → Site URL* | `https://www.ipepper.com.br` |
| Supabase → *Redirect URLs* | `https://www.ipepper.com.br/auth/callback` e `https://www.ipepper.com.br/**` |

> Não cadastre `/auth/callback` do app como redirect URI no Google: o `code` é
> trocado pelo Supabase. O par `Client ID`/`Client Secret` do Google vai em
> *Supabase → Authentication → Providers → Google*.

---

## 5. Checklist final antes de enviar

- [ ] `next build` sem erros e as 5 rotas em `○ (Static)`.
- [ ] `https://www.ipepper.com.br/privacidade` e `/termos` retornam `200` sem
      cookies/sessão.
- [ ] Ambas exibem `contato@ipepper.com.br`, `(17) 99265-0646` e o link
      "Voltar para o início".
- [ ] Rodapé da home tem "Política de Privacidade" e "Termos de Uso"
      (`next/link`).
- [ ] `canonical` de cada página aponta para o domínio `www`.
- [ ] `robots.txt` libera `/` e publica o `Sitemap:`; `sitemap.xml` lista as
      três URLs públicas.
- [ ] Home, política e termos usam **a mesma marca** escrita na tela de
      consentimento.
- [ ] Domínio verificado no Search Console e app publicado (In production).

---

## 6. Erros comuns e correção

| Mensagem do Google | Causa provável | Correção |
| --- | --- | --- |
| *The app name doesn't match the name on your home page* | marca divergente entre título, home e política | padronizar `ipepper` nos `<title>`, no logo e no `App name` |
| *Invalid privacy policy URL* | redirect para login, `404` ou domínio não autorizado | garantir `200` anônimo e HTTPS no domínio `www` |
| *Authorized domain not verified* | Search Console em outra conta/propriedade | verificar `ipepper.com.br` na conta que publica o app |
| *Terms of service URL is invalid* | `/termos` inexistente ou protegida | conferir `next build` e Deployment Protection |
| Verificação do redirect | `redirect_uri_mismatch` no login | usar exatamente `https://<ref>.supabase.co/auth/v1/callback` |

