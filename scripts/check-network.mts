// @ts-nocheck  -- operator tool, run via tsx
/**
 * Manual network check. Roda na SUA máquina, na SUA rede, e diz se a mídia
 * (WebRTC/ICE) vai conseguir sair - a sinalização não precisa mais disso, ela
 * passa pelo relé hospedado (docs/DESIGN.md secção 2.2/18):
 *
 *   npx tsx scripts/check-network.mts
 *
 * Faz de verdade: descobre o IP externo por STUN e diz se há CGNAT no caminho.
 * Nenhum dado sai da sua máquina além do pacote STUN.
 */

import { DEFAULT_STUN_SERVERS, discoverExternalAddress, isCarrierGradeNat } from '../src/main/net/stun.js';
import { primaryLanIpv4, allLanIpv4 } from '../src/main/net/local-ip.js';

console.log(`IP(s) local: ${allLanIpv4().join(', ') || '(nenhum)'}`);
console.log(`LAN primária: ${primaryLanIpv4() ?? '(nenhuma)'}`);
console.log(`consultando STUN (${DEFAULT_STUN_SERVERS.map((s) => s.host).join(', ')})...\n`);

const external = await discoverExternalAddress(DEFAULT_STUN_SERVERS, { localPort: 0 });

console.log(`endereço externo : ${external.address} (${external.family})`);

if (external.family === 'ipv4' && isCarrierGradeNat(external.address)) {
  console.log('\n❌ CGNAT detectado — o hole punching de mídia tende a falhar sem TURN.');
} else {
  console.log('\n✅ Endereço externo normal — o hole punching de mídia (ICE) deve funcionar.');
}
console.log(
  '\n(a sinalização hoje passa pelo relé hospedado: nenhuma porta de entrada é necessária para isso.)',
);
process.exit(0);
