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
# ou: npm run dev  (watch, sem build)
```

`GET /healthz` → `{"ok":true,"rooms":N}`.

## Deploy no Render (grátis)

Veja [`render.yaml`](render.yaml). Resumo: fork do repo → Render → New → Blueprint
→ escolha o repo (Root Directory = `server`) → Deploy. Copie a URL e aponte o app
para `wss://<host>`.

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
