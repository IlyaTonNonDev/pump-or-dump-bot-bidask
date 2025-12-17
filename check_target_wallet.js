#!/usr/bin/env node
/**
 * Проверка баланса целевого кошелька
 */

const { Address, TonClient } = require('@ton/ton');

async function main() {
  try {
    const targetAddress = 'UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty';
    console.log('🔍 Проверка баланса целевого кошелька\n');
    console.log(`📍 Адрес: ${targetAddress}`);
    console.log(`   https://tonviewer.com/${targetAddress}\n`);
    
    const address = Address.parse(targetAddress);
    console.log(`   Raw адрес: ${address.toString()}\n`);
    
    // Создаем TON Client
    const tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC'
    });
    
    // Получаем баланс через HTTP API напрямую
    try {
      const response = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${address.toString()}`, {
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        const balance = BigInt(data.result.balance || 0);
        const balanceTon = (Number(balance) / 1e9).toFixed(4);
        
        console.log(`✅ Баланс кошелька:`);
        console.log(`   ${balance.toString()} nanoTON`);
        console.log(`   ${balanceTon} TON\n`);
        
        if (balance > 0n) {
          console.log(`✅ Кошелек имеет баланс ${balanceTon} TON!`);
        } else {
          console.log('⚠️  Баланс равен 0');
        }
      } else {
        console.log('❌ Не удалось получить баланс через API');
      }
    } catch (error) {
      console.error(`❌ Ошибка: ${error.message}`);
      console.log('\n💡 Проверьте баланс вручную на:');
      console.log(`   https://tonviewer.com/${targetAddress}`);
    }
    
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
  }
}

main();



