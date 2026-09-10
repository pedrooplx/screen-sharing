# Teste manual de mídia (checkpoint 3.3)

O caminho **werift ↔ werift** (SFU encaminhando entre dois peers werift) é
coberto por `test/sfu/router.test.ts`. O que só dá para validar com um browser
real é **werift ↔ Chromium** — a negociação SDP/ICE entre o `RTCPeerConnection`
do renderer e o `RTCPeerConnection` do werift no `main`. Este é o roteiro.

## Pré-requisitos

- Windows 11, `npm install` feito.
- Duas instâncias do app na mesma máquina (localhost) ou em duas máquinas na
  mesma LAN.

## Passo a passo (uma máquina, duas instâncias)

1. Terminal A: `npm run dev`
2. Terminal B: `npm run dev` (o electron-vite reaproveita o servidor do
   renderer; a segunda janela abre em segundos)
3. **Instância A** — "Criar uma sala": apelido `ana`, senha `x`. Copie o código.
4. **Instância B** — "Entrar numa sala": apelido `bruno`, cole o código, senha
   `x`. As duas listas de participantes devem mostrar `ana` e `bruno`.
5. **Instância A** — "Transmitir minha tela" → escolha uma tela ou janela.
   - O preview local aparece no card "Sua transmissão".
   - O rótulo passa de `negociando…` para `no ar`.
   - Na **instância B**, `ana` ganha o badge verde `transmitindo` e aparece um
     tile em "Transmissões da sala".
6. **Instância B** — "Assistir" no tile da `ana`.
   - O tile mostra `conectando…` e em 1–3 s troca para o vídeo da tela da `ana`.
   - Se `ana` estava com áudio do sistema, você ouve (cuidado com
     realimentação — use fones ou baixe o volume).
7. **Instância B** — "Parar": o vídeo some, a assinatura fecha.
8. **Instância A** — "Parar": o stream some da lista da `ana` e da `bruno`.

## O que observar / possíveis problemas

| Sintoma | Provável causa |
|---|---|
| Fica em `negociando…` para sempre | o `publish_answer` não voltou — ver o console do `main` (electron-log) por erro de SDP no werift |
| `assinatura falhou: ...` no tile | incompatibilidade de codec ou de SDP entre werift e Chromium — anotar a mensagem; é o sinal de que o plano B (`mediasoup`) pode ser necessário |
| Vídeo conecta mas congela | keyframe não chegou; o SFU manda PLI ao primeiro RTP, mas se falhar o Chromize espera o próximo keyframe natural (~2 s) |
| `Permission denied` ao escolher a fonte | o `setDisplayMediaRequestHandler` não resolveu — confirmar que `registerCaptureHandler()` roda no `whenReady` |

## Logs

`electron-log` grava em `%APPDATA%\erros-share\logs\main.log`. Erros de
`hostRoom` / `joinRoom` / `sendMedia` aparecem lá.
