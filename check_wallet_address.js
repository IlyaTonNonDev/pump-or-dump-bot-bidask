#!/usr/bin/env node
/**
 * Скрипт для проверки адреса кошелька из seed фразы
 */

require('dotenv').config({ path: './secretkeys.env' });
const crypto = require('crypto');
const { WalletContractV4, WalletContractV5R1, WalletContractV5Beta, Address } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');

// Функции шифрования/дешифрования из bot.js
function decryptSeedPhrase(encryptedData) {
  try {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const textParts = encryptedData.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error(`[DECRYPT] ❌ Error decrypting seed phrase:`, error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log('🔍 Проверка адреса кошелька из seed фразы\n');
    
    // Получаем seed фразу
    const encryptedSeed = process.env.ENCRYPTED_WALLET_SEED;
    if (!encryptedSeed) {
      throw new Error('ENCRYPTED_WALLET_SEED is not set');
    }
    
    const seedPhrase = decryptSeedPhrase(encryptedSeed);
    console.log(`✅ Seed фраза расшифрована (${seedPhrase.split(' ').length} слов)\n`);
    
    // Создаем ключевую пару
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    console.log(`✅ Ключевая пара создана`);
    console.log(`   Public Key: ${keyPair.publicKey.toString('hex').substring(0, 40)}...\n`);
    
    // Создаем кошелек V5R1 (современный стандарт)
    const walletV5R1 = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    
    const addressV5R1 = walletV5R1.address;
    console.log(`📋 Адрес кошелька (WalletContractV5R1):`);
    console.log(`   ${addressV5R1.toString()}`);
    console.log(`   User-friendly: ${addressV5R1.toString({urlSafe: true, bounceable: false})}`);
    console.log(`   https://tonviewer.com/${addressV5R1.toString({urlSafe: true, bounceable: false})}\n`);
    
    // Также проверяем V4 для сравнения
    const walletV4 = WalletContractV4.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    console.log(`📋 Адрес кошелька (WalletContractV4):`);
    console.log(`   ${walletV4.address.toString()}\n`);
    
    // Ожидаемый адрес (user-friendly формат)
    const expectedAddressUserFriendly = 'UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty';
    // Конвертируем в raw формат для сравнения
    const expectedAddressRaw = Address.parse(expectedAddressUserFriendly);
    
    console.log(`🎯 Ожидаемый адрес (user-friendly):`);
    console.log(`   ${expectedAddressUserFriendly}`);
    console.log(`🎯 Ожидаемый адрес (raw):`);
    console.log(`   ${expectedAddressRaw.toString()}`);
    console.log(`   https://tonviewer.com/${expectedAddressUserFriendly}\n`);
    
    // Сравнение (сравниваем raw адреса)
    if (addressV5R1.toString() === expectedAddressRaw.toString()) {
      console.log('✅ Адреса СОВПАДАЮТ!');
    } else {
      console.log('❌ Адреса НЕ СОВПАДАЮТ!');
      console.log('\nВозможные причины:');
      console.log('1. Seed фраза не соответствует этому кошельку');
      console.log('2. Используется другой тип кошелька (не V4)');
      console.log('3. Seed фраза была зашифрована неправильно\n');
      
      // Пробуем другие типы кошельков, включая V5Beta
      console.log('🔍 Проверка других типов кошельков...\n');
      
      try {
        const { WalletContractV5Beta, WalletContractV3R2, WalletContractV3R1, WalletContractV2R2, WalletContractV2R1 } = require('@ton/ton');
        
        const walletV5Beta = WalletContractV5Beta.create({
          publicKey: keyPair.publicKey,
          workchain: 0,
        });
        const addrV5Beta = walletV5Beta.address.toString();
        console.log(`WalletContractV5Beta: ${addrV5Beta}`);
        if (addrV5Beta === expectedAddressRaw.toString()) {
          console.log('   ✅ СОВПАДАЕТ С ОЖИДАЕМЫМ!');
        }
        
        const walletV3R2 = WalletContractV3R2.create({
          publicKey: keyPair.publicKey,
          workchain: 0,
        });
        const addrV3R2 = walletV3R2.address.toString();
        console.log(`WalletContractV3R2: ${addrV3R2}`);
        if (addrV3R2 === expectedAddressRaw.toString()) {
          console.log('   ✅ СОВПАДАЕТ С ОЖИДАЕМЫМ!');
        }
        
        const walletV3R1 = WalletContractV3R1.create({
          publicKey: keyPair.publicKey,
          workchain: 0,
        });
        const addrV3R1 = walletV3R1.address.toString();
        console.log(`WalletContractV3R1: ${addrV3R1}`);
        if (addrV3R1 === expectedAddressRaw.toString()) {
          console.log('   ✅ СОВПАДАЕТ С ОЖИДАЕМЫМ!');
        }
        
        const walletV2R2 = WalletContractV2R2.create({
          publicKey: keyPair.publicKey,
          workchain: 0,
        });
        const addrV2R2 = walletV2R2.address.toString();
        console.log(`WalletContractV2R2: ${addrV2R2}`);
        if (addrV2R2 === expectedAddressRaw.toString()) {
          console.log('   ✅ СОВПАДАЕТ С ОЖИДАЕМЫМ!');
        }
        
        const walletV2R1 = WalletContractV2R1.create({
          publicKey: keyPair.publicKey,
          workchain: 0,
        });
        const addrV2R1 = walletV2R1.address.toString();
        console.log(`WalletContractV2R1: ${addrV2R1}`);
        if (addrV2R1 === expectedAddressRaw.toString()) {
          console.log('   ✅ СОВПАДАЕТ С ОЖИДАЕМЫМ!');
        }
      } catch (e) {
        console.log(`Ошибка при проверке других типов: ${e.message}`);
      }
      
      console.log('\n💡 Решение:');
      console.log('Если ни один адрес не совпадает, возможно:');
      console.log('1. Seed фраза не соответствует кошельку UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty');
      console.log('2. Нужно перешифровать правильную seed фразу через: node encrypt_seed.js');
      console.log('3. Или использовать адрес напрямую (если известен приватный ключ)');
    }
    
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
    process.exit(1);
  }
}

main();

