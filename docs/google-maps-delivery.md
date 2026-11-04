# Entrega por distância com Google Maps

Guia de configuração e manutenção do autocomplete de endereço e do cálculo de
taxa por rota (Google Places + Google Routes API).

## Visão geral

```
Checkout (/[slug]/checkout)
  └─ AddressAutocomplete ──► Places API (New)      [navegador, chave pública]
        └─ rua, número, bairro, cidade, UF, CEP, lat/lng
              │
              ├─ POST /api/delivery-quote  → pré-visualiza a taxa
              └─ POST /api/orders          → valida e grava o pedido
                        │
                        └─ lib/deliveryQuote.ts
                              ├─ lib/cep.ts         (BrasilAPI → ViaCEP → Nominatim)
                              ├─ lib/googleRoutes.ts (Routes API, rota real)
                              └─ lib/delivery.ts     (regra de preço + raio)
```

O servidor é sempre a fonte da verdade: o valor enviado pelo navegador nunca é
aceito. `POST /api/orders` recalcula a taxa exatamente como a pré-visualização.

## 1. Google Cloud

1. Crie (ou use) um projeto no [Google Cloud Console](https://console.cloud.google.com/).
2. Ative o faturamento — as duas APIs são cobradas por uso (há cota gratuita
   mensal por conta).
3. Em **APIs e serviços → Biblioteca**, habilite:
   - **Places API (New)** — sugestões de endereço no checkout;
   - **Maps JavaScript API** — carrega o widget `<gmp-place-autocomplete>`
     (Places UI Kit) no navegador;
   - **Routes API** — distância/tempo de carro (`computeRoutes`).
4. Crie **duas** chaves em **APIs e serviços → Credenciais**:

| Chave | Uso | Restrição recomendada |
| --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | navegador (Places/Maps JS) | HTTP referrers: `https://ipepper.com.br/*`, `https://*.ipepper.com.br/*`, `http://localhost:3000/*` + somente *Places API (New)* / *Maps JavaScript API* |
| `GOOGLE_MAPS_API_KEY` | servidor (Routes API) | Restrição por IP da hospedagem (ou "Nenhuma" se o IP for dinâmico) + somente *Routes API* |

> A chave pública aparece no HTML — isso é esperado. A proteção vem da restrição
> por referrer. A chave de servidor nunca deve ter `NEXT_PUBLIC_` no nome.

Sem `GOOGLE_MAPS_API_KEY`, o servidor tenta `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
como fallback (útil em desenvolvimento com uma única chave).

### 1.1 Autocomplete: Places API (New), não a legada

O campo de rua usa o Web Component `google.maps.places.PlaceAutocompleteElement`
(`<gmp-place-autocomplete>`, Places UI Kit), carregado por
`lib/googleMapsPlaces.ts`.

- A Maps JS API é carregada com `v=weekly` — versão mínima que expõe o
  `PlaceAutocompleteElement`; `libraries=places` + `loading=async` evitam
  bloquear a renderização do checkout;
- a API antiga (`google.maps.places.Autocomplete`) **não** é usada: contas do
  Google Cloud criadas a partir de março/2025 não conseguem ativar a Places API
  legada e o console falha com `LegacyApiNotActivatedMapError`;
- ao selecionar uma sugestão chegam `addressComponents` no formato novo
  (`longText`/`shortText`) e `location`; o loader normaliza para os campos do
  formulário e o widget é ligado ao React pelo host `<div>` do
  `AddressAutocomplete` (`gmp-select` → `placePrediction.toPlace()` →
  `fetchFields()`);
- o visual é alinhado pelos custom properties do Places UI Kit em
  `app/globals.css` (`.ipepper-place-autocomplete`), já que o widget vive em
  shadow DOM e não recebe as classes Tailwind do input.

## 2. Variáveis de ambiente

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=chave-publica-do-navegador
GOOGLE_MAPS_API_KEY=chave-do-servidor
```

`NEXT_PUBLIC_*` é inlinada no build: ao alterá-la, **rebuilde** o projeto
(`npm run build`). Em `next dev` basta reiniciar o servidor.

## 3. Banco de dados

Aplique `supabase/migrations/20261110000024_add_delivery_distance_to_orders.sql`
no SQL Editor do Supabase. Ela adiciona a `public.orders`:

| Coluna | Tipo | Conteúdo |
| --- | --- | --- |
| `delivery_distance_km` | `numeric(6,2)` | distância da rota usada na taxa (km) |
| `delivery_duration_minutes` | `integer` | tempo estimado de percurso (min) |
| `delivery_distance_source` | `text` | `google_routes` ou `haversine` |

Enquanto a migração não roda, `POST /api/orders` detecta as colunas ausentes,
regrava o pedido sem elas e mantém o fluxo normal (com a taxa calculada).

## 4. Contratos das rotas

### `POST /api/delivery-quote` (público)

```jsonc
// requisição
{
  "establishment_id": "uuid-da-loja",
  "cep": "01310100",        // opcional (8 dígitos)
  "latitude": -23.561414,   // opcional — vem do autocomplete
  "longitude": -46.655881,
  "place_id": "ChIJ..."     // opcional
}

// resposta 200
{
  "distance_km": 3.42,
  "duration_minutes": 12,
  "distance_source": "google_routes",
  "quote": {
    "delivery_type": "distance",
    "fee": 8.5,
    "distance_km": 3.42,
    "duration_minutes": 12,
    "distance_source": "google_routes",
    "within_radius": true,
    "max_delivery_radius_km": 8,
    "fee_source": "distance",
    "requires_cep": true,
    "cep": "01310100",
    "destination": { "latitude": -23.561414, "longitude": -46.655881, "place_id": "ChIJ..." },
    "address": { "street": "Av. Paulista", "neighborhood": "Bela Vista", "city": "São Paulo", "state": "SP" },
    "warnings": []
  }
}
```

Erros: `400` endereço ausente/inválido ou CEP inexistente; `404` loja inativa;
`500` falha ao carregar a loja.

### `POST /api/orders` (público)

Aceita os mesmos campos dentro de `customer`:

```jsonc
"customer": {
  "name": "João", "phone": "11999998888",
  "cep": "01310100", "street": "Av. Paulista", "number": "1000",
  "neighborhood": "Bela Vista", "city": "São Paulo",
  "complement": "apto 12", "reference": "…",
  "latitude": -23.561414, "longitude": -46.655881, "place_id": "ChIJ..."
}
```

- recota a entrega (`quoteDelivery`) antes de qualquer gravação;
- fora do raio → `400 Endereço fora do raio de entrega da loja (X km de
  distância, limite de Y km).`;
- grava `delivery_fee`, `delivery_distance_km`, `delivery_duration_minutes`,
  `delivery_distance_source` e as coordenadas em `customer_address`.

## 5. Regra de preço e raio

Definida pelo lojista em `/painel/configuracoes` (tabela `establishments`):

| Campo | Significado |
| --- | --- |
| `delivery_type` | `fixed` (taxa fixa) ou `distance` (por km) |
| `delivery_fee` | taxa fixa — também é o fallback do modelo por distância |
| `distance_base_km` | km inclusos na taxa base |
| `distance_base_fee` | valor cobrado até `distance_base_km` |
| `distance_extra_km_fee` | valor por km excedente |
| `max_delivery_radius_km` | raio máximo (null = sem limite) |
| `store_cep` / `store_latitude` / `store_longitude` | origem do cálculo |

Fórmula (`lib/delivery.ts → computeDistanceFee`):

```
taxa = distance_base_fee + max(0, km - distance_base_km) × distance_extra_km_fee
```

A distância é arredondada para 2 casas (exibição em 1 casa) e `0 km` é tratado
como “sem distância” para nunca cobrar 0 nem exibir “0,0 km”.

## 6. Degradação (fallback)

| Situação | Resultado |
| --- | --- |
| sem `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | campo de rua comum; cálculo segue pelo CEP |
| sem `GOOGLE_MAPS_API_KEY` / erro / timeout | distância Haversine; `distance_source = "haversine"`; aviso na UI |
| CEP não encontrado e sem coordenadas | `400` pedindo o endereço |
| CEP não encontrado **com** coordenadas | segue com as coordenadas do Places |
| loja sem origem configurada | taxa fixa (`fee_source = "fixed_fallback"`) + aviso |

## 7. Custos e cache

- `computeRoutes` usa `X-Goog-FieldMask: routes.distanceMeters,routes.duration`
  — pedir apenas o necessário reduz o custo por chamada;
- resultados ficam em cache **em memória por instância** por 10 minutos
  (`lib/googleRoutes.ts`), com chave `origem|destino` arredondada a ~1 m. Digitar
  e trocar o número na mesma rua não gera novas chamadas;
- o Places Autocomplete é cobrado por sessão de digitação: cada visita ao
  checkout carrega a Maps JS API uma única vez (promise compartilhada em
  `lib/googleMapsPlaces.ts`) e o widget `<gmp-place-autocomplete>` é criado no
  host do `AddressAutocomplete`, com `fetchFields()` restrito a
  `displayName`, `formattedAddress`, `addressComponents` e `location`;
- não há chamadas ao Google para lojas de **taxa fixa sem raio**: a cotação
  resolve a taxa localmente.

## 8. Verificação rápida (local)

```bash
# 1. Tipos e lint
npx tsc --noEmit
npx eslint app lib context --max-warnings=0

# 2. Build (inlina NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)
npm run build

# 3. Cotação com coordenadas (troque o UUID pela loja ativa)
curl -s -X POST http://localhost:3000/api/delivery-quote \
  -H 'Content-Type: application/json' \
  -d '{"establishment_id":"<uuid>","latitude":-23.561414,"longitude":-46.655881}' | jq

# Esperado sem chave de servidor:
#   { "distance_km": 3.42, "distance_source": "haversine", "duration_minutes": null, ... }
# Esperado com GOOGLE_MAPS_API_KEY:
#   { "distance_km": 4.1, "distance_source": "google_routes", "duration_minutes": 13, ... }
```

## 9. Problemas comuns

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| Nenhuma sugestão aparece | chave pública ausente/inválida ou Places API (New) desabilitada | preencha `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, habilite a API e **rebuilde** |
| Console: `LegacyApiNotActivatedMapError` | código ainda usando `google.maps.places.Autocomplete` (API legada, indisponível em projetos criados após março/2025) | use o `PlaceAutocompleteElement` (`<gmp-place-autocomplete>`) de `lib/googleMapsPlaces.ts` / `AddressAutocomplete` |
| Console: `ApiNotActivatedMapError` / `RefererNotAllowedMapError` | *Maps JavaScript API* ou *Places API (New)* desabilitada, ou domínio fora das restrições da chave | habilite as APIs e adicione o domínio (com `/*`) nas restrições da chave |
| Console: `RefererNotAllowedMapError` | restrição por referrer não inclui o domínio atual | adicione o domínio (com `/*`) nas restrições da chave |
| `distance_source` sempre `haversine` | `GOOGLE_MAPS_API_KEY` ausente, Routes API desabilitada, chave com restrição de referrer ou limite de cota | veja o `console.warn` `[googleRoutes] computeRoutes falhou` no log do servidor |
| Taxa some e vira "taxa fixa" | loja sem `store_cep`/coordenadas, ou endereço sem CEP e sem coordenadas | configure a origem em `/painel/configuracoes`; use o autocomplete no checkout |
| Pedido grava sem `delivery_distance_km` | migração `20261110000024` não aplicada | rode a migração no Supabase |

## 10. Privacidade

As coordenadas do endereço ficam no `customer_address` do pedido (JSONB) e nos
campos `delivery_*` — apenas para o painel da loja, o cálculo da taxa e a
navegação do entregador. Nenhum dado é enviado ao Google além do texto digitado
no autocomplete e do par de coordenadas enviado à Routes API (sem nome, telefone
ou itens do pedido).


