# erros-share

Compartilhamento de tela P2P entre várias pessoas, estilo Discord, **sem
nenhum servidor que você precise manter no ar**. O mesmo executável roda em
todos os PCs; quem cria a sala vira o coordenador (host) da sessão.

- Topologia estrela com o host atuando como mini-SFU (toda a mídia passa por ele).
- Só o host precisa estar acessível de fora; os demais participantes usam
  hole punching por ICE.
- Failover automático: se o host cai, outro participante assume.
- Entrada por **código da sala + senha**. A senha nunca trafega (PAKE CPace).

> Estado atual: **Fase 1 em andamento** (núcleo de sinalização e sessão, sem
> vídeo). Veja [docs/DESIGN.md](docs/DESIGN.md) para a arquitetura completa e o
> [status por fase](#status-por-fase) abaixo.

---

## Assunções desta versão

- **Nickname por sessão**, sem cadastro nem conta persistente.
- **Sala efêmera**: deixa de existir quando esvazia. Sem histórico, sem gravação.
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
- **STUN público** é usado apenas para descobrir o IP externo do host (um pacote
  UDP, nenhuma mídia passa por lá). Servidores configuráveis.
- **TURN** é um ponto de extensão opcional que você aponta para um servidor
  próprio; nada é hospedado por padrão.

---

## Requisitos de rede

Para **criar** uma sala (ser host), o seu PC precisa aceitar conexões de fora.
O app tenta automaticamente, nesta ordem: **PCP → NAT-PMP → UPnP-IGD**. Se
nenhum funcionar, ele mostra a porta exata (padrão **TCP 47821**) para você
encaminhar manualmente no roteador.

Você **não pode ser host** se:

- Seu provedor usa **CGNAT** (comum em internet móvel e rural) — o app detecta e
  avisa.
- O roteador não tem UPnP e você não configurou port forwarding.

Para **entrar** numa sala, normalmente não é preciso configurar nada: a mídia se
resolve por hole punching. A exceção é os dois lados estarem atrás de **NAT
simétrico** sem TURN configurado — aí a conexão de mídia não fecha. O app diz
isso com todas as letras quando acontece.

Para checar sua rede antes de tentar hospedar:

```bash
npm run check:network
```

---

## Modelo de ameaça (resumo)

A sala é um grupo de pessoas que já se conhecem e combinaram uma senha por fora.
A confiança é *no grupo*; o host é um membro do grupo, não um terceiro.

| Quem | O que consegue | O que **não** consegue |
|---|---|---|
| ISP / rede no caminho | ver que há tráfego, volume, horários | ler a sinalização ou a mídia |
| Alguém com o código, sem a senha | tentar entrar e ser bloqueado por rate limit | entrar, ver o roster, ver mídia, **ou atacar a senha offline** |
| Alguém tentando se passar pelo host | fazer você conectar nele | passar o handshake — a conexão morre antes de qualquer dado |
| Participante autorizado | assistir qualquer transmissão, virar host por sucessão, ver nicknames e IPs externos dos demais | — |
| O host | **ver e ouvir toda a mídia em claro** (v1) | ler a senha (ela nunca trafega) |

Detalhes e o que a criptografia cobre: [docs/DESIGN.md §10](docs/DESIGN.md).

---

## Desenvolvimento

```bash
npm install
npm run dev        # sobe o app Electron (renderer + main)
npm test           # roda a suíte (vitest)
npm run typecheck  # tsc: Node + renderer
npm run build:app  # build de produção em out/
```

Estrutura em `src/`:

| Caminho | Papel |
|---|---|
| `src/shared/` | contrato de protocolo (`zod`) e de IPC |
| `src/main/crypto/` | CPace (PAKE), Argon2id/HKDF, AES-256-GCM |
| `src/main/net/` | frames autenticados, STUN, mapeamento de porta, `heir_probe` |
| `src/main/room/` | código da sala (Base32 Crockford + CRC-16) + orquestrador STUN/NAT |
| `src/main/election/` | ordem de sucessão determinística + coordenador de failover |
| `src/main/signaling/` | servidor (host), cliente (peer), roster, heartbeat, `PeerNode` |
| `src/main/app/` | `RoomSession` (une host↔peer), IPC, captura de tela |
| `src/main/sfu/` | mini-SFU werift: `router`, `codecs`, `media-plane` |
| `src/main/index.ts` | entry do processo principal do Electron |
| `src/preload/` | ponte `contextBridge` → `window.erros` |
| `src/renderer/` | UI React em pt-BR (`useMedia` para o WebRTC) |

Para mexer só na UI sem Electron: `npx vite src/renderer` e abra `http://localhost:5173/?mock`
(um stub de `window.erros` com dados de exemplo).

---

## Status por fase

- [x] **Fase 0** — Design doc ([docs/DESIGN.md](docs/DESIGN.md)).
- [x] **Fase 1** — Núcleo de sinalização e sessão (sem vídeo).
  - [x] Núcleo criptográfico: derivação de chave, CPace (verificado contra os
        vetores de teste do draft do CFRG), AEAD, codec de frames.
  - [x] Codec do código de sala + ordem de sucessão, com testes.
  - [x] Transporte WebSocket + handshake CPace ponta a ponta: `SignalingServer`
        (host) e `SignalingClient` (peer), admissão por senha, rate limiting
        por IP. Testado com host + 3 peers no mesmo processo.
  - [x] STUN (implementado à mão, validado contra o Google) + UPnP/NAT-PMP/PCP
        (`@achingbrain/nat-port-mapper`) + geração real do código de sala.
        `npm run check:network` roda tudo na sua rede.
  - [x] Heartbeat ping/pong com detecção de queda; probe de alcançabilidade
        de entrada (`inboundVerified`).
  - [x] Spike do werift como SFU concluído ([docs/SPIKE-SFU.md](docs/SPIKE-SFU.md)).
- [x] **Fase 2** — Failover de host.
  - [x] `epoch` monotônico; peer rejeita `joined` com epoch menor que o conhecido.
  - [x] `inboundEndpoint` no roster (host preenche ao provar alcançabilidade).
  - [x] `heir_probe` UDP autenticado por `w` (anti-split-brain), `HeirProbeResponder`
        sempre ligado em cada peer.
  - [x] `Failover` — coordenador determinístico: promove / re-homing / reconecta /
        encerra sala.
  - [x] `PeerNode` — junta cliente + responder + failover + promoção a
        `SignalingServer` no epoch+1.
  - [x] `host_transfer` para saída graciosa (sem esperar timeout).
  - [x] Testável: `test/signaling/failover.integration.test.ts` mata o host e vê
        um peer assumir enquanto os outros reconectam.
- [ ] **Fase 3** — Mídia (captura, SFU, assinatura seletiva, adaptação).
  - [x] Shell Electron + renderer React (pt-BR) + `RoomSession` + IPC tipado.
        Lobby (criar/entrar por código+senha) e tela de sala com roster ao vivo,
        código e status de rede. `npm run dev`. Testes: `test/app/room-session.test.ts`.
  - [x] Captura de tela/janela + áudio do sistema (WASAPI loopback): seletor de
        fontes com miniatura e prévia local em `<video>` (`CapturePanel`).
  - [x] Mini-SFU werift no `main` (`src/main/sfu/`); publish/subscribe ponta a
        ponta com encaminhamento RTP sem transcodificar. Múltiplas assinaturas
        por peer. `quality_directive`: pausa o encoder do transmissor quando
        ninguém assiste, restaura quando volta. Aviso ao assistir muitos fluxos.
        werift↔werift testado; **interop com o Chromium: rodar
        `docs/TESTING-MEDIA.md`** com o app real.
  - [ ] Governor completo: escada de qualidade progressiva + `stats_report`.
  - [ ] ICE trickle (hoje non-trickle — junta candidatos e manda o SDP).
  - [ ] Governor (escada de qualidade, avisos de performance) + `stats_report`.
  - [ ] Restaurar estado de mídia após failover.
- [ ] **Fase 4** — Empacotamento (electron-builder) e robustez.

---

## Limitações conhecidas

Estas são verdades sobre o produto, não bugs pendentes. A lista cresce conforme
as fases avançam.

1. **NAT simétrico nas duas pontas, sem TURN configurado → a mídia não conecta.**
   A interface informa e o design explica como apontar um TURN próprio.
2. **Host atrás de CGNAT → não pode ser host.** O app detecta e avisa.
3. **Sem UPnP e sem port forwarding manual → não pode ser host.** O app mostra a
   porta exata e o passo a passo.
4. **Após um failover, o código de sala antigo deixa de funcionar** (ele contém
   IP:porta do host antigo). Quem já está na sala migra sozinho; quem está de
   fora precisa do código novo.
5. **Sem simulcast:** a qualidade de uma transmissão é a mesma para todos os
   seus espectadores, então um espectador com internet ruim pode fazer o
   transmissor baixar a qualidade para todos.
6. **O host enxerga a mídia em claro.** A criptografia fim-a-fim através do host
   é um ponto de extensão pronto (Insertable Streams + `roomMediaKey`), mas não
   vem ligada na v1. Justificativa no modelo de ameaça.
7. **Uma partição de rede pode gerar duas salas paralelas com o mesmo código.**
   Quem ficar do lado "errado" simplesmente não vê os outros.
8. **O primeiro uso dispara o alerta do Firewall do Windows.** Sem permitir,
   ninguém conecta.
9. **Áudio é do sistema inteiro, não da janela escolhida.** Ao transmitir uma
   janela específica, o vídeo é dela, mas o áudio continua sendo o do sistema.
10. **Realimentação de áudio:** se você transmite áudio e assiste alguém ao
    mesmo tempo, seus espectadores também ouvem quem você está assistindo (o
    loopback do Windows captura tudo). A interface avisa quando as duas coisas
    estão ativas.
11. **Windows 11 apenas. Sem auto-update.**
12. **Sala efêmera:** esvaziou, acabou. Sem histórico, sem gravação.
13. **Um único monitor por transmissão.**
14. **`inboundVerified` é só um TCP connect.** O host confirma que consegue
    abrir uma conexão para a porta anunciada pelo peer, mas ainda não prova
    (com um handshake curto) que o listener é daquele peer. O `heir_probe` UDP
    autenticado por `w` cobre parte disso no failover.
15. **O failover reconecta só o plano de controle.** Restaurar quem transmitia
    e o que cada um assistia entra junto com a mídia (Fase 3).
