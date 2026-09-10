// @ts-nocheck  -- operator tool, run via tsx
/**
 * Manual network check (Fase 1). Roda na SUA máquina, na SUA rede, e diz se
 * você conseguiria ser host de uma sala:
 *
 *   npx tsx scripts/check-network.mts [--port=47821]
 *
 * Faz de verdade: descobre o IP externo por STUN, tenta abrir a porta por
 * PCP/NAT-PMP/UPnP, monta um código de sala de exemplo, e libera a porta ao
 * sair. Nenhum dado sai da sua máquina além do pacote STUN.
 */

import { discoverHostEndpoint } from '../src/main/room/host-endpoint.js';
import { primaryLanIpv4, allLanIpv4 } from '../src/main/net/local-ip.js';

const port = Number(
  process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 47821,
);

console.log(`IP(s) local: ${allLanIpv4().join(', ') || '(nenhum)'}`);
console.log(`LAN primária: ${primaryLanIpv4() ?? '(nenhuma)'}`);
console.log(`testando porta TCP ${port}...\n`);

const info = await discoverHostEndpoint({ port });

console.log(`método de mapeamento : ${info.mappingMethod}`);
console.log(`endereço externo     : ${info.endpoint.address}:${info.endpoint.port}`);
console.log(`atrás de NAT          : ${info.directlyReachable ? 'não' : 'sim'}`);

if (info.blocker === 'carrier_grade_nat') {
  console.log('\n❌ CGNAT detectado — seu provedor não deixa você aceitar conexões.');
  console.log('   Você pode ENTRAR em salas, mas não pode ser host.');
} else if (info.blocker === 'no_inbound_path') {
  console.log('\n⚠  Não foi possível abrir a porta automaticamente.');
  console.log(`   Configure port forwarding: TCP ${port} -> ${primaryLanIpv4()}:${port}`);
} else {
  console.log('\n✅ Você consegue ser host.');
  console.log(`\ncódigo de sala de exemplo:\n   ${info.code}`);
}

await info.close();
process.exit(0);
