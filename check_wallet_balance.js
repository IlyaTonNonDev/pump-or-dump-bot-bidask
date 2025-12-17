#!/usr/bin/env node
/**
 * Проверка баланса кошелька из seed фразы
 */

require('dotenv').config({ path: './secretkeys.env' });
const crypto = require('crypto');
const { TonClient, Address } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const { WalletContractV5R1 } = require('@ton/ton');

// Расшифровка seed фразы
function decryptSeedPhrase(encryptedSeed, encryptionKey, encryptionIv) {
  try {
    const [ivHex, encryptedHex] = encryptedSeed.split(':');
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Ошибка при расшифровке: ${error.message}`);
  }
}

async function main() {
  try {
    console.log('🔍 Проверка баланса кошелька из seed фразы\n');
    
    const encryptedSeed = process.env.ENCRYPTED_WALLET_SEED;
    const encryptionKey = process.env.ENCRYPTION_KEY;
    const encryptionIv = process.env.ENCRYPTION_IV;
    
    if (!encryptedSeed || !encryptionKey || !encryptionIv) {
      throw new Error('Не найдены ENCRYPTED_WALLET_SEED, ENCRYPTION_KEY или ENCRYPTION_IV в secretkeys.env');
    }
    
    // Расшифровываем seed фразу
    const seedPhrase = decryptSeedPhrase(encryptedSeed, encryptionKey, encryptionIv);
    const wordCount = seedPhrase.split(' ').length;
    console.log(`✅ Seed фраза расшифрована (${wordCount} слов)\n`);
    
    // Создаем ключевую пару
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    
    // Создаем кошелек V5R1 (как в bot.js)
    const wallet = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    
    const walletAddress = wallet.address;
    const walletAddressUserFriendly = walletAddress.toString({urlSafe: true, bounceable: false});
    
    console.log('📋 Адрес кошелька:');
    console.log(`   Raw: ${walletAddress.toString()}`);
    console.log(`   User-friendly: ${walletAddressUserFriendly}`);
    console.log(`   https://tonviewer.com/${walletAddressUserFriendly}\n`);
    
    // Подключаемся к TON
    const tonClient = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    });
    
    console.log('💰 Проверка баланса...\n');
    
    // Получаем баланс через HTTP API (надежный способ)
    const response = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${walletAddress.toString()}`, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Failed to fetch balance`);
    }
    
    const data = await response.json();
    const balance = BigInt(data.result.balance || 0);
    const balanceTon = Number(balance) / 1e9;
    
    if (balance === BigInt(0)) {
      console.log('⚠️  Баланс равен 0. Убедитесь, что это правильный кошелек.');
      console.log(`   Проверьте транзакцию на: https://tonviewer.com/${walletAddressUserFriendly}\n`);
    } else {
      console.log('✅ Баланс кошелька:');
      console.log(`   ${balance} nanoTON`);
      console.log(`   ${balanceTon.toFixed(4)} TON\n`);
      
      // Проверяем достаточность для покупки
      const buyAmountTon = parseFloat(process.env.BUY_AMOUNT_TON || '1');
      const minTonReserve = parseFloat(process.env.MIN_TON_RESERVE || '1');
      const requiredTon = buyAmountTon + minTonReserve;
      
      if (balanceTon >= requiredTon) {
        console.log(`✅ Достаточно средств для покупки (нужно ${requiredTon} TON)`);
      } else {
        console.log(`⚠️  Недостаточно средств для покупки (нужно ${requiredTon} TON, есть ${balanceTon.toFixed(4)} TON)`);
      }
    }
    
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
