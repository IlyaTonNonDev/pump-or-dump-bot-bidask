#!/usr/bin/env node
/**
 * Интерактивный скрипт для настройки всех необходимых ключей бота
 * 
 * Использование:
 *   node setup_keys.js
 */

const crypto = require('crypto');
const readline = require('readline');
const fs = require('fs').promises;
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

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

// Генерация ключей шифрования
function generateEncryptionKeys() {
  const key = crypto.randomBytes(32).toString('hex');
  const iv = crypto.randomBytes(16).toString('hex');
  return { key, iv };
}

// Проверка существования файла
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Чтение существующих значений из файла
async function readExistingKeys() {
  const envFile = path.join(__dirname, 'secretkeys.env');
  const existing = {};
  
  if (await fileExists(envFile)) {
    const content = await fs.readFile(envFile, 'utf8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=');
        if (key && value) {
          existing[key.trim()] = value.trim();
        }
      }
    }
  }
  
  return existing;
}

async function main() {
  console.log('🔐 Настройка ключей для Pump/Dump Bot\n');
  console.log('Этот скрипт поможет вам настроить все необходимые ключи.\n');
  
  const existing = await readExistingKeys();
  const newKeys = {};
  
  try {
    // 1. TELEGRAM_BOT_TOKEN
    console.log('📱 1. Telegram Bot Token');
    if (existing.TELEGRAM_BOT_TOKEN) {
      const use = await question(`   Токен уже существует. Использовать существующий? (y/n): `);
      if (use.toLowerCase() !== 'y') {
        newKeys.TELEGRAM_BOT_TOKEN = await question('   Введите TELEGRAM_BOT_TOKEN (от @BotFather): ');
      } else {
        newKeys.TELEGRAM_BOT_TOKEN = existing.TELEGRAM_BOT_TOKEN;
      }
    } else {
      newKeys.TELEGRAM_BOT_TOKEN = await question('   Введите TELEGRAM_BOT_TOKEN (от @BotFather): ');
    }
    console.log('');
    
    // 2. TON_API_KEY
    console.log('🔗 2. TON API Key');
    if (existing.TON_API_KEY) {
      const use = await question(`   Ключ уже существует. Использовать существующий? (y/n): `);
      if (use.toLowerCase() !== 'y') {
        newKeys.TON_API_KEY = await question('   Введите TON_API_KEY (от https://tonconsole.com): ');
      } else {
        newKeys.TON_API_KEY = existing.TON_API_KEY;
      }
    } else {
      newKeys.TON_API_KEY = await question('   Введите TON_API_KEY (от https://tonconsole.com): ');
    }
    console.log('');
    
    // 3. Wallet Seed Phrase
    console.log('💼 3. Wallet Seed Phrase');
    console.log('   ВАЖНО: Seed фраза будет зашифрована перед сохранением.');
    const seedPhrase = await question('   Введите seed фразу кошелька (12 или 24 слова): ');
    
    if (!seedPhrase.trim()) {
      throw new Error('Seed фраза не может быть пустой');
    }
    
    // 4. Encryption Keys
    console.log('\n🔑 4. Генерация ключей шифрования...');
    const { key, iv } = generateEncryptionKeys();
    const encryptedSeed = encryptSeedPhrase(seedPhrase.trim(), key, iv);
    
    newKeys.ENCRYPTED_WALLET_SEED = encryptedSeed;
    newKeys.ENCRYPTION_KEY = key;
    newKeys.ENCRYPTION_IV = iv;
    console.log('   ✅ Ключи шифрования сгенерированы');
    console.log('   ✅ Seed фраза зашифрована\n');
    
    // 5. BUY_AMOUNT_TON
    console.log('💰 5. Сумма покупки');
    if (existing.BUY_AMOUNT_TON) {
      const use = await question(`   Текущая сумма: ${existing.BUY_AMOUNT_TON} TON. Использовать? (y/n): `);
      if (use.toLowerCase() !== 'y') {
        const amount = await question('   Введите сумму покупки в TON (по умолчанию 1): ');
        newKeys.BUY_AMOUNT_TON = amount.trim() || '1';
      } else {
        newKeys.BUY_AMOUNT_TON = existing.BUY_AMOUNT_TON;
      }
    } else {
      const amount = await question('   Введите сумму покупки в TON (по умолчанию 1): ');
      newKeys.BUY_AMOUNT_TON = amount.trim() || '1';
    }
    console.log('');
    
    // Сохранение в файл
    console.log('💾 Сохранение ключей...\n');
    
    const envFile = path.join(__dirname, 'secretkeys.env');
    let content = `# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=${newKeys.TELEGRAM_BOT_TOKEN}

# TON API Configuration
TON_API_KEY=${newKeys.TON_API_KEY}

# Wallet Configuration
# ВАЖНО: Seed фраза зашифрована. Никогда не делитесь этими ключами!
ENCRYPTED_WALLET_SEED=${newKeys.ENCRYPTED_WALLET_SEED}

# Encryption Configuration
# Эти ключи используются для шифрования/дешифрования seed фразы
ENCRYPTION_KEY=${newKeys.ENCRYPTION_KEY}
ENCRYPTION_IV=${newKeys.ENCRYPTION_IV}

# Purchase Configuration
BUY_AMOUNT_TON=${newKeys.BUY_AMOUNT_TON}
`;
    
    await fs.writeFile(envFile, content, 'utf8');
    // Устанавливаем безопасные права доступа (только владелец может читать и писать)
    await fs.chmod(envFile, 0o600);
    
    console.log('✅ Все ключи успешно сохранены в secretkeys.env (права доступа: 600)\n');
    console.log('📋 Резюме:');
    console.log(`   • Telegram Bot Token: ${newKeys.TELEGRAM_BOT_TOKEN.substring(0, 20)}...`);
    console.log(`   • TON API Key: ${newKeys.TON_API_KEY.substring(0, 20)}...`);
    console.log(`   • Wallet Seed: [зашифровано]`);
    console.log(`   • Encryption Key: ${newKeys.ENCRYPTION_KEY.substring(0, 20)}...`);
    console.log(`   • Encryption IV: ${newKeys.ENCRYPTION_IV.substring(0, 20)}...`);
    console.log(`   • Buy Amount: ${newKeys.BUY_AMOUNT_TON} TON\n`);
    
    console.log('⚠️  ВАЖНО:');
    console.log('   • Файл secretkeys.env содержит секретные данные');
    console.log('   • Убедитесь, что он добавлен в .gitignore');
    console.log('   • Никогда не коммитьте этот файл в репозиторий!');
    console.log('   • Храните резервную копию ключей шифрования в безопасном месте\n');
    
    console.log('🚀 Бот готов к запуску! Используйте: npm start\n');
    
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}\n`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();


