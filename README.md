# erros-share

Compartilhamento de tela P2P entre várias pessoas, estilo Discord. O mesmo
executável roda em todos os PCs; quem cria a sala vira o coordenador (host) da
**mídia** daquela sessão.

- Topologia estrela com o host atuando como mini-SFU (toda a mídia passa por ele).
- **Ninguém precisa abrir porta no roteador.** A sinalização (quem entrou, senha,
  roster) passa por um relé hospedado gratuito; a mídia continua P2P direta via
  hole punching ICE.
- Entrada por **código da sala + senha**. A senha nunca trafega (PAKE CPace) —
  nem para o relé, que só encaminha bytes cifrados que ele não consegue ler.

> Estado atual: **Fases 0-3 concluídas** (sinalização, sessão e mídia
> funcionando; failover automático de host está **parcado**, ver abaixo). Veja
> [docs/DESIGN.md](docs/DESIGN.md) para a arquitetura completa — em especial o
> **§18**, que documenta o relé — e o [status por fase](#status-por-fase) abaixo.

---

## Assunções desta versão

- **Nickname por sessão**, sem cadastro nem conta persistente.
- **Sala efêmera**: deixa de existir quando o host sai ou perde o link com o
  relé. Sem histórico, sem gravação, e (por ora) **sem failover** — ver
  [Limitações conhecidas](#limitações-conhecidas).
- Alvo de qualidade padrão: **1080p/30fps** por transmissão, adaptativo para
  baixo até 720p/15fps sob pressão de banda ou CPU. Bitrate alvo configurável
  (padrão ~2,5 Mbps por stream).
- **Windows 11** é o alvo. A arquitetura permite portar depois; macOS/Linux não
  são implementados agora.
- **Chat de texto fora de escopo** — há um ponto de extensão via data channel,
  sem UI.
- **Sem microfone, sem webcam, sem gravação.**
- **Sem auto-update.** A distribuição é o instalador gerado manualmente.
- Idioma da interface: **português (pt-BR)**. Código e comentários em inglês.
- **STUN público** é usado para o hole punching de mídia (um pacote UDP,
  nenhuma mídia passa por lá). Servidores configuráveis.
- **TURN** é um ponto de extensão opcional que você aponta para um servidor
  próprio; nada é hospedado por padrão.
- **A sinalização passa por um relé hospedado** (Render free tier, por
  padrão). Ele só encaminha bytes opacos — nunca vê senha, SDP, mídia ou
  nicknames em claro. Veja [server/README.md](server/README.md) para rodar o
  seu próprio.

---

## Requisitos de rede

**Para criar OU entrar numa sala, você não precisa configurar nada no
roteador.** A sinalização faz só conexões de saída, para o relé — isso é
justamente o que o pivô da v0.4 resolveu (era o maior ponto de atrito da v0.3).

A **mídia** continua P2P e resolve por hole punching ICE na grande maioria das
redes domésticas. Você só tem problema se:

- Os dois lados estiverem atrás de **NAT simétrico** sem TURN configurado — a
  conexão de mídia não fecha. O app diz isso com todas as letras quando
  acontece.

Duas ressalvas específicas do relé hospedado (gratuito):

- Ele **dorme após ~15 min sem uso** e leva 30-50 s para acordar. Se a
  primeira tentativa de criar/entrar numa sala demorar, é isso — a UI mostra
  "acordando o servidor…".
- A sala **depende do relé estar no ar**. Se preferir não depender do público,
  rode o seu (`server/README.md`, deploy de um clique no Render) e aponte
  `ERROS_RELAY_URL` para ele.

Para checar a parte de mídia da sua rede (STUN, CGNAT) antes de usar o app:

```bash
npm run check:network
```

---

## Modelo de ameaça (resumo)

A sala é um grupo de pessoas que já se conhecem e combinaram uma senha por fora.
A confiança é *no grupo*; o host é um membro do grupo, não um terceiro; e o
**relé de sinalização é tratado como rede hostil**, no mesmo nível do ISP.

| Quem | O que consegue | O que **não** consegue |
|---|---|---|
| ISP / rede no caminho | ver que há tráfego, volume, horários | ler a sinalização ou a mídia |
| O relé de sinalização | ver `roomId`, quantidade de conexões, IPs (rate limit) | ler qualquer conteúdo — CPace e os frames continuam cifrados ponta a ponta através dele |
| Alguém com o código, sem a senha | tentar entrar e ser bloqueado por rate limit (host e relé) | entrar, ver o roster, ver mídia, **ou atacar a senha offline** |
| Alguém tentando se passar pelo host | fazer você conectar nele | passar o handshake — a conexão morre antes de qualquer dado |
| Participante autorizado | assistir qualquer transmissão, ver nicknames e IPs externos dos demais | forjar mensagens de host |
| O host | **ver e ouvir toda a mídia em claro** (v1) | ler a senha (ela nunca trafega, nem para o relé) |

Detalhes e o que a criptografia cobre: [docs/DESIGN.md §10](docs/DESIGN.md) (modelo de ameaça) e [§18](docs/DESIGN.md) (o relé).

---

## Desenvolvimento

```bash
npm install
npm run dev        # sobe o app Electron (renderer + main)
npm test           # roda a suíte (vitest) - inclui um relé real em memória
npm run typecheck  # tsc: Node + renderer + server/
npm run build:app  # build de produção em out/
```

O relé (`server/`) é um pacote **separado**, com seu próprio
`package.json`/`node_modules` — veja [server/README.md](server/README.md) para
rodá-lo localmente ou fazer o deploy. Em dev, o app aponta para o relé público
padrão a menos que você exporte `ERROS_RELAY_URL=ws://127.0.0.1:8787` (ou a URL
do seu próprio deploy).

Estrutura em `src/`:

| Caminho | Papel |
|---|---|
| `src/shared/` | contrato de protocolo (`zod`) e de IPC |
| `src/main/crypto/` | CPace (PAKE), Argon2id/HKDF, AES-256-GCM |
| `src/main/net/` | frames autenticados, `Transport`/`ConnectionSource`, cliente do relé (`relay-link.ts`), STUN (mídia) |
| `src/main/room/` | código da sala v2 (Base32 Crockford + CRC-16 sobre `roomId`+`codeSalt`) |
| `src/main/signaling/` | `SignalingServer` (host) e `SignalingClient` (peer), rodando sobre um `Transport`/`ConnectionSource` injetado |
| `src/main/app/` | `RoomSession` (host = relé+server; peer = relé+client), IPC, captura de tela |
| `src/main/sfu/` | mini-SFU werift: `router`, `codecs`, `media-plane`, `governor` |
| `src/main/index.ts` | entry do processo principal do Electron |
| `src/preload/` | ponte `contextBridge` → `window.erros` |
| `src/renderer/` | UI React em pt-BR (`useMedia` para o WebRTC) |
| `server/` | **pacote separado**: o relé de sinalização hospedado (Node, `ws`+`zod`) |
| `parked/` | código completo e testado, fora do build (`npm test`/`typecheck` não tocam) — failover automático de host e a descoberta STUN/UPnP do plano de controle antigo. Ver `parked/README.md`. |

Para mexer só na UI sem Electron: `npx vite src/renderer` e abra `http://localhost:5173/?mock`
(um stub de `window.erros` com dados de exemplo).

---

## Status por fase

- [x] **Fase 0** — Design doc ([docs/DESIGN.md](docs/DESIGN.md)).
- [x] **Fase 1** — Núcleo de sinalização e sessão (sem vídeo).
  - [x] Núcleo criptográfico: derivação de chave, CPace (verificado contra os
        vetores de teste do draft do CFRG), AEAD, codec de frames.
  - [x] Codec do código de sala + ordem de sucessão, com testes.
  - [x] Transporte WebSocket + handshake CPace ponta a ponta, admissão por
        senha, rate limiting por IP. Testado com host + 3 peers no mesmo processo.
  - [x] Heartbeat ping/pong com detecção de queda.
- [x] **Fase 2** — Failover de host. Implementado e testado; **parcado desde a
      Fase "relé" abaixo** (o relé v1 não tem reconexão de host). Código
      preservado em `parked/` — veja [docs/DESIGN.md §18.5](docs/DESIGN.md)
      para o que falta pra reviver.
- [x] **Fase 3** — Mídia (captura, SFU, assinatura seletiva, adaptação).
  - [x] Shell Electron + renderer React (pt-BR) + `RoomSession` + IPC tipado.
  - [x] Captura de tela/janela + áudio do sistema (WASAPI loopback).
  - [x] Mini-SFU werift no `main`; publish/subscribe ponta a ponta com
        encaminhamento RTP sem transcodificar; encaminhamento seletivo.
        werift↔werift testado; **interop com o Chromium: rodar
        `docs/TESTING-MEDIA.md`** com o app real.
  - [x] Governor de qualidade: escada 1080p30→720p→480p, degradação por
        perda/CPU medida, recuperação gradual.
  - [ ] ICE trickle (hoje non-trickle — junta candidatos e manda o SDP).
  - [ ] Teste de campo real entre máquinas de casas diferentes.
- [x] **Fase "relé"** — Sinalização hospedada (v0.4, [docs/DESIGN.md §18](docs/DESIGN.md)).
  - [x] `server/`: relé WS standalone, deployável no Render (`render.yaml`).
        Só encaminha bytes opacos; CPace e AEAD continuam ponta a ponta.
  - [x] `Connection` roda sobre um `Transport` abstrato; `SignalingServer`
        sobre um `ConnectionSource` — local (`ws`, testes) ou o relé
        (`RelayHostLink`/`RelayPeerLink`).
  - [x] Código de sala v2 (só `roomId`+`codeSalt`, sem IP/porta).
  - [x] Retry com backoff para o cold start do relé free-tier + keep-alive
        enquanto a sala está ativa.
  - [x] Failover automático **parcado** (dependia de reconexão de host, que o
        relé v1 não oferece).
- [ ] **Fase 4** — Empacotamento (electron-builder), URL de relé de produção
      real, e robustez.

---

## Limitações conhecidas

Estas são verdades sobre o produto, não bugs pendentes. A lista cresce conforme
as fases avançam.

1. **NAT simétrico nas duas pontas, sem TURN configurado → a mídia não conecta.**
   A interface informa e o design explica como apontar um TURN próprio. Este é
   hoje o **único** cenário de rede que pode te impedir de usar o app — CGNAT
   e "sem UPnP" não impedem mais ninguém de hospedar (só afetavam a
   sinalização antiga).
2. **A sala depende do relé de sinalização estar no ar.** Mitigado com retry
   de conexão (cobre o cold start do free tier, ~30-50 s) e a opção de rodar
   o seu próprio relé (`server/README.md`).
3. **Sem failover automático de host.** Se quem hospeda sai ou perde o link
   com o relé, **a sala termina para todo mundo** — sem promoção de ninguém.
   Foi implementado e testado (Fase 2), está parcado em `parked/` até o relé
   suportar reconexão de host ([docs/DESIGN.md §18.5](docs/DESIGN.md)).
4. **Sem simulcast:** a qualidade de uma transmissão é a mesma para todos os
   seus espectadores, então um espectador com internet ruim pode fazer o
   transmissor baixar a qualidade para todos.
5. **O host enxerga a mídia em claro.** A criptografia fim-a-fim através do host
   é um ponto de extensão pronto (Insertable Streams + `roomMediaKey`), mas não
   vem ligada na v1. Justificativa no modelo de ameaça.
6. **O primeiro uso dispara o alerta do Firewall do Windows** para a parte de
   mídia (a sinalização não recebe conexões de entrada, então não precisa de
   regra nenhuma). Sem permitir, ninguém vê vídeo.
7. **Áudio é do sistema inteiro, não da janela escolhida.** Ao transmitir uma
   janela específica, o vídeo é dela, mas o áudio continua sendo o do sistema.
8. **Realimentação de áudio:** se você transmite áudio e assiste alguém ao
   mesmo tempo, seus espectadores também ouvem quem você está assistindo (o
   loopback do Windows captura tudo). A interface avisa quando as duas coisas
   estão ativas.
9. **Windows 11 apenas. Sem auto-update.**
10. **Sala efêmera:** esvaziou (ou o host saiu), acabou. Sem histórico, sem gravação.
11. **Um único monitor por transmissão.**
