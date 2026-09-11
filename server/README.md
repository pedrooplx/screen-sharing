# erros-share — signaling relay

Um multiplexador WebSocket minúsculo. Deixa o host de uma sala e os peers se
alcançarem **sem ninguém abrir porta**. Encaminha **bytes opacos** — CPace e os
frames AES-256-GCM do plano de controle são ponta a ponta, então este processo
**nunca vê**: senha da sala, SDP, ICE, mídia, ou apelidos.

## O que ele vê

- `roomId` (4 bytes hex) — identificador aleatório da sala.
- Quantas conexões há em cada sala e qual é o host.
- Os IPs das conexões (para rate limiting).

Nada mais. A mídia (WebRTC) **não passa por aqui** — é P2P direto entre os peers.

## Rodar localmente

```bash
cd server
npm install
npm run build && npm start        # :8787
```

`GET /healthz` → `{"ok":true,"rooms":N}`.

**`typescript`/`@types/*` estão em `dependencies`, não `devDependencies`, de
propósito.** Render (e a maioria dos PaaS que rodam `buildCommand`+
`startCommand` no mesmo container) fazem `npm ci` com `NODE_ENV=production`
já setado no ambiente de build — e a partir do npm 9, isso faz o `npm ci`
pular `devDependencies` silenciosamente. Como o build (`tsc`) roda *depois*
desse install, ele quebra com `TS2688: Cannot find type definition file for
'node'` (ou qualquer outro `@types/*`/o próprio `tsc` faltando). Não tem
"build stage" separado aqui pra isolar isso — então a correção é manter as
ferramentas de build como dependência normal. Custo: uns poucos MB extras em
`node_modules` que sobrevivem até o runtime, sem efeito prático (nada em
`dist/` os importa).

## Deploy no Render (grátis)

Veja [`render.yaml`](render.yaml). Resumo: fork do repo → Render → New → Blueprint
→ escolha o repo (Root Directory = `server`) → Deploy. Copie a URL (`https://<host>`)
e aponte o app para `wss://<host>` via a variável de ambiente `ERROS_RELAY_URL`
(veja `src/main/net/relay-config.ts` no repo raiz) — hoje isso ainda não é
automático no build de produção; até lá, `DEFAULT_RELAY_URL` naquele arquivo é
só um placeholder e precisa ser atualizado à mão com a URL real.

Porta: lida de `process.env.PORT` (o Render injeta automaticamente); default
`8787` fora dele.

**Free tier:** dorme após 15 min ocioso, ~40 s para acordar. O app trata isso:
retenta a primeira conexão e faz ping enquanto há sala ativa.

## Limites (padrão, em `relay.ts`)

| | |
|---|---|
| Salas simultâneas | 500 |
| Peers por sala | 24 |
| Criação de sala / IP | 10 por 60 s |
| Entradas / IP | 40 por 60 s |
| Payload máximo | 512 KB |
| Timeout ocioso | ~70 s sem ping/dados |

## Sem reconexão de host (v1)

Se o WebSocket do host cai, a sala encerra (os peers recebem `HOST_GONE`).
Uma janela de reconexão com token fica para uma versão futura.
