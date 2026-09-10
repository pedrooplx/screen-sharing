# Spike — werift como mini-SFU

> Executado na Fase 1 para retirar o maior risco do projeto
> ([DESIGN.md §14, risco 1](DESIGN.md)). Script: [`scripts/spike-sfu-throughput.mts`](../scripts/spike-sfu-throughput.mts).

## Pergunta

O encaminhamento de RTP + re-encriptação SRTP em **JavaScript puro** (werift, no
processo `main`) aguenta o pior caso de tráfego de um host doméstico —
~6.200 pacotes/s de saída (2 transmissores × 12 participantes a 720p)?

## Montagem

```
publisher werift ──RTP sintético 2,5 Mbps / 30 fps──▶ SFU werift
                                                        │  (só reenvia; sem
                                                        │   decode/encode)
                                                        ▼
                                              N subscribers werift
```

Tudo num processo só (pessimista: a geração da fonte e a recepção dos N
assinantes também consomem CPU do mesmo processo). Mede a janela em regime,
descartando 2 s de aquecimento de DTLS/ICE.

## Resultado (8 assinantes, 20 s, máquina de desenvolvimento)

| Métrica | Valor |
|---|---|
| Entrada no SFU | ~265 pkt/s |
| Saída do SFU (8× fan-out) | ~2.120 pkt/s |
| Perda | **0,00 %** |
| CPU do processo inteiro | **~25 % de um núcleo** |
| Custo por pacote (all-in) | ~105 µs |
| **Projeção para 6.200 pkt/s** | **~64 % de um núcleo** |

## Conclusão

**werift é viável para ≤ 12 participantes.** Mesmo a medição pessimista (fonte +
SFU + todos os assinantes no mesmo processo) fica em ~64 % de um núcleo no pior
caso realista. Num build real, a geração de mídia fica no renderer e os
assinantes são outros PCs, então o custo só do SFU é bem menor.

Onde há aperto: 12 transmissores simultâneos (~37.000 pkt/s) continua fora de
alcance — mas isso já é recusado por admissão no design. A escada de qualidade
do governor (§8.5) mantém o número de pacotes sob controle.

## O que este spike NÃO cobriu

- **Interoperabilidade de negociação SDP/ICE com o Chromium.** werift↔werift
  funciona; werift↔Chromium só dá para validar de verdade na Fase 3, com um
  renderer Electron real capturando tela. Se aparecer incompatibilidade lá, o
  plano B continua sendo `mediasoup` (nativo), ao custo de empacotar um worker
  binário.
- Reescrita de cabeçalho RTP com offset de sequência/timestamp por assinatura
  (o spike reenvia o pacote direto). Custo adicional é de aritmética de
  inteiros — desprezível perto do SRTP.
- Comportamento sob perda real de rede e sob PLI/keyframe gating.
