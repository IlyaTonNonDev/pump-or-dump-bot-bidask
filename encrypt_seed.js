#!/usr/bin/env node
/**
 * Утилита для шифрования seed фразы кошелька
 * 
 * Использование:
 *   node encrypt_seed.js "your seed phrase here"
 * 
 * Или интерактивно:
 *   node encrypt_seed.js
 */

const crypto = require('crypto');
const readline = require('readline');

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
    console.error('❌ Ошибка при шифровании:', error.message);
    throw error;
  }
}

// Основная функция
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  try {
    // Получаем seed фразу из аргументов или интерактивно
    let seedPhrase = process.argv[2];
    
    if (!seedPhrase) {
      console.log('🔐 Утилита шифрования seed фразы\n');
      seedPhrase = await question('Введите вашу seed фразу (12 или 24 слова): ');
    }

    seedPhrase = seedPhrase.trim();
    
    if (!seedPhrase) {
      console.error('❌ Seed фраза не может быть пустой');
      process.exit(1);
    }

    // Генерируем ключи шифрования
    console.log('\n🔑 Генерация ключей шифрования...');
    const { key, iv } = generateEncryptionKeys();

    // Шифруем seed фразу
    console.log('🔒 Шифрование seed фразы...');
    const encryptedSeed = encryptSeedPhrase(seedPhrase, key, iv);

    // Выводим результат
    console.log('\n✅ Seed фраза успешно зашифрована!\n');
    console.log('📋 Добавьте следующие строки в ваш secretkeys.env файл:\n');
    console.log('ENCRYPTED_WALLET_SEED=' + encryptedSeed);
    console.log('ENCRYPTION_KEY=' + key);
    console.log('ENCRYPTION_IV=' + iv);
    console.log('\n⚠️  ВАЖНО: Храните эти данные в безопасности!');
    console.log('⚠️  Никогда не делитесь этими ключами с третьими лицами!');
    console.log('⚠️  Убедитесь, что secretkeys.env добавлен в .gitignore!\n');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();




