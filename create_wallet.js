#!/usr/bin/env node
/**
 * Создание нового кошелька для бота
 * Генерирует seed фразу, создает кошелек, шифрует и сохраняет в secretkeys.env
 */

require('dotenv').config({ path: './secretkeys.env' });
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { WalletContractV5R1, Address } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const bip39 = require('bip39');

// Генерация seed фразы (24 слова)
function generateSeedPhrase() {
  // Генерируем 256 бит энтропии для 24 слов
  const entropy = crypto.randomBytes(32);
  return bip39.entropyToMnemonic(entropy.toString('hex'));
}

// Генерация ключей шифрования
function generateEncryptionKeys() {
  const key = crypto.randomBytes(32).toString('hex');
  const iv = crypto.randomBytes(16).toString('hex');
  return { key, iv };
}

// Шифрование seed фразы
function encryptSeedPhrase(seedPhrase, encryptionKey, encryptionIv) {
  try {
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const iv = Buffer.from(encryptionIv, 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(seedPhrase, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    throw new Error(`Ошибка при шифровании: ${error.message}`);
  }
}

async function main() {
  try {
    console.log('🔐 Создание нового кошелька для бота\n');
    
    // Генерируем seed фразу
    console.log('📝 Генерация seed фразы...');
    const seedPhrase = generateSeedPhrase();
    console.log(`✅ Seed фраза сгенерирована (24 слова)\n`);
    
    // Создаем ключевую пару
    console.log('🔑 Создание ключевой пары...');
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    console.log(`✅ Ключевая пара создана\n`);
    
    // Создаем кошелек V5R1
    console.log('💼 Создание кошелька V5R1...');
    const wallet = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    
    const walletAddress = wallet.address;
    const walletAddressUserFriendly = walletAddress.toString({urlSafe: true, bounceable: false});
    
    console.log(`✅ Кошелек создан!\n`);
    console.log(`📋 Адрес кошелька:`);
    console.log(`   ${walletAddressUserFriendly}`);
    console.log(`   Raw: ${walletAddress.toString()}`);
    console.log(`   https://tonviewer.com/${walletAddressUserFriendly}\n`);
    
    // Генерируем ключи шифрования
    console.log('🔐 Генерация ключей шифрования...');
    const { key, iv } = generateEncryptionKeys();
    const encryptedSeed = encryptSeedPhrase(seedPhrase, key, iv);
    console.log(`✅ Seed фраза зашифрована\n`);
    
    // Читаем существующий файл
    const envFile = path.join(__dirname, 'secretkeys.env');
    let content = '';
    try {
      content = await fs.readFile(envFile, 'utf8');
    } catch (e) {
      // Файл не существует, создадим новый
    }
    
    // Обновляем значения
    const lines = content.split('\n');
    const newLines = [];
    let foundEncryptedSeed = false;
    let foundEncryptionKey = false;
    let foundEncryptionIv = false;
    
    for (const line of lines) {
      if (line.startsWith('ENCRYPTED_WALLET_SEED=')) {
        newLines.push(`ENCRYPTED_WALLET_SEED=${encryptedSeed}`);
        foundEncryptedSeed = true;
      } else if (line.startsWith('ENCRYPTION_KEY=')) {
        newLines.push(`ENCRYPTION_KEY=${key}`);
        foundEncryptionKey = true;
      } else if (line.startsWith('ENCRYPTION_IV=')) {
        newLines.push(`ENCRYPTION_IV=${iv}`);
        foundEncryptionIv = true;
      } else {
        newLines.push(line);
      }
    }
    
    // Если не нашли строки, добавляем их
    if (!foundEncryptedSeed || !foundEncryptionKey || !foundEncryptionIv) {
      // Ищем место для вставки
      let insertIndex = newLines.length;
      for (let i = 0; i < newLines.length; i++) {
        if (newLines[i].includes('Wallet Configuration') || newLines[i].includes('ENCRYPTED_WALLET_SEED')) {
          insertIndex = i;
          break;
        }
      }
      
      if (!foundEncryptedSeed) {
        newLines.splice(insertIndex, 0, `ENCRYPTED_WALLET_SEED=${encryptedSeed}`);
      }
      if (!foundEncryptionKey) {
        newLines.splice(insertIndex + 1, 0, `ENCRYPTION_KEY=${key}`);
      }
      if (!foundEncryptionIv) {
        newLines.splice(insertIndex + 2, 0, `ENCRYPTION_IV=${iv}`);
      }
    }
    
    // Сохраняем файл
    await fs.writeFile(envFile, newLines.join('\n'), 'utf8');
    // Устанавливаем безопасные права доступа (только владелец может читать и писать)
    await fs.chmod(envFile, 0o600);
    
    console.log('💾 Сохранено в secretkeys.env (права доступа: 600)\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ КОШЕЛЕК УСПЕШНО СОЗДАН!');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📋 АДРЕС КОШЕЛЬКА (для перевода TON):');
    console.log(`   ${walletAddressUserFriendly}\n`);
    console.log('🔗 Проверить кошелек:');
    console.log(`   https://tonviewer.com/${walletAddressUserFriendly}\n`);
    console.log('⚠️  ВАЖНО:');
    console.log('   • Seed фраза зашифрована и сохранена в secretkeys.env');
    console.log('   • НЕ ДЕЛИТЕСЬ seed фразой ни с кем!');
    console.log('   • После перевода TON кошелек будет готов к использованию');
    console.log('   • Для покупки нужно минимум 2 TON (1 TON покупка + 1 TON резерв)\n');
    console.log('📝 Seed фраза (сохраните в безопасном месте!):');
    console.log(`   ${seedPhrase}\n`);
    console.log('═══════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

