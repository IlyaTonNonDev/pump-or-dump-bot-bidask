// Telegram Bot: Pump/Dump Event System
require('dotenv').config({ path: './secretkeys.env' });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { TonClient, WalletContractV5R1, internal, toNano, Address, beginCell } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const { JettonMaster, JettonWallet } = require('@ton/ton');

// ==================== КОНФИГУРАЦИЯ ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

// Проверка на множественные запуски
const lockFile = path.join(__dirname, '.bot.lock');

async function acquireLock() {
  try {
    // Проверяем, существует ли lock файл
    try {
      const pid = await fs.readFile(lockFile, 'utf8');
      // Проверяем, жив ли процесс
      try {
        process.kill(parseInt(pid.trim()), 0); // Проверка существования процесса
        throw new Error(`Another bot instance is already running (PID: ${pid.trim()}). Please stop it first with: pkill -f "node bot.js"`);
      } catch (killError) {
        if (killError.message.includes('Another bot instance')) {
          throw killError;
        }
        // Процесс не существует, удаляем старый lock файл
        await fs.unlink(lockFile);
      }
    } catch (statError) {
      if (statError.code !== 'ENOENT') {
        throw statError;
      }
      // Lock файл не существует, продолжаем
    }
    
    // Создаем lock файл с текущим PID
    await fs.writeFile(lockFile, process.pid.toString(), 'utf8');
    console.log(`[LOCK] ✅ Lock acquired (PID: ${process.pid})`);
    
    // Очистка при выходе
    const cleanup = async () => {
      try {
        await fs.unlink(lockFile);
      } catch (e) {}
    };
    
    process.on('exit', cleanup);
    process.on('SIGINT', async () => {
      await cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await cleanup();
      process.exit(0);
    });
  } catch (error) {
    console.error(`[LOCK] ❌ ${error.message}`);
    process.exit(1);
  }
}

// Получаем блокировку перед запуском
(async () => {
  await acquireLock();
})();

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ВАЖНО: Установите ID чата, где будут работать команды /pump, /dump, /pumpOrDump
// Чтобы получить ID чата, добавьте бота @userinfobot в чат или используйте @getidsbot
// Пример: const ALLOWED_PUMP_DUMP_CHAT_ID = -1001234567890;
const ALLOWED_PUMP_DUMP_CHAT_ID = -1003117681845; // ID чата для pump/dump команд

// ==================== МАГАЗИН БУСТЕРОВ ====================
// ПРИМЕЧАНИЕ: Для цифровых товаров provider_token не требуется (можно использовать пустую строку)
// Согласно документации: https://core.telegram.org/bots/payments-stars
// provider_token нужен только для физических товаров и услуг
const STARS_PROVIDER_TOKEN = process.env.TELEGRAM_STARS_PROVIDER_TOKEN || '';
const FREE_SHOP_MODE = process.env.FREE_SHOP_MODE === 'true'; // Бесплатный тестовый режим магазина
const SHOP_IMAGE_URL = 'https://raw.githubusercontent.com/IlyaTonNonDev/pump-or-dump-bot-bidask/main/gift.png';

// ==================== БЛОКИРОВКА ТРАНЗАКЦИЙ ====================
const DISABLE_TRANSACTIONS = process.env.DISABLE_TRANSACTIONS === 'true'; // Блокировка транзакций на выкуп/продажу TONDEV

const STORE_ITEMS = {
  pump10: {
    id: 'pump10',
    title: 'PUMP/DUMP +10',
    priceStars: 12,
    delta: 10,
    description: 'Одноразово сдвигает результат ивента на ±10 через команды pump10/dump10. 100% Stars идут на выкуп $TONDEV.'
  },
  pump25: {
    id: 'pump25',
    title: 'PUMP/DUMP +25',
    priceStars: 30,
    delta: 25,
    description: 'Одноразово сдвигает результат ивента на ±25 через команды pump25/dump25. 100% Stars идут на выкуп $TONDEV.'
  },
  pump50: {
    id: 'pump50',
    title: 'PUMP/DUMP +50',
    priceStars: 60,
    delta: 50,
    description: 'Одноразово сдвигает результат ивента на ±50 через команды pump50/dump50. 100% Stars идут на выкуп $TONDEV.'
  }
};

const STORE_ITEM_LIST = Object.values(STORE_ITEMS);

// ==================== PUMP/DUMP EVENT STATE ====================
let pumpDumpEvent = {
  isActive: false,
  finishResult: 0,
  pumpThreshold: null, // Порог для pump (фиксируется при старте ивента)
  dumpThreshold: null, // Порог для dump (фиксируется при старте ивента)
  pinnedMessageId: null, // ID закрепленного сообщения об ивенте
  eventChatId: null // ID чата, где запущен ивент
};

// Инвентарь пользователей: { [userId]: { [itemId]: count } }
let userInventory = {};

// Блокировка для предотвращения race conditions
let eventLock = false;

// Персональные блокировки для пользователей (защита от спама применения бустеров)
let userLocks = {}; // { [userId]: true/false }

// Флаг для предотвращения множественных одновременных вызовов updateEventMessage при старте
let isUpdatingEventMessage = false;

// Флаг для предотвращения множественных одновременных транзакций при завершении ивента
let isProcessingTransaction = false;
const FINISH_THRESHOLD = 5; // Тестовое значение (в продакшене должно быть 500)
const MIN_PUMP_THRESHOLD = 10; // Минимальный порог для pump (никогда не меньше 10)
const MAX_PUMP_THRESHOLD = 250; // Максимальный порог для pump (никогда не больше 250)
const MIN_DUMP_THRESHOLD = 250; // Минимальный порог для dump (абсолютное значение, проверка: finishResult <= -250)
const MAX_DUMP_THRESHOLD = 10; // Максимальный порог для dump (абсолютное значение, проверка: finishResult <= -10)

// ПРИМЕЧАНИЕ: Изменение стоимости Stars за сообщение в чате недоступно через Bot API
// Согласно документации Telegram Bot API (https://core.telegram.org/bots/api),
// нет метода для изменения стоимости Stars за сообщение.
// Эта настройка доступна только через интерфейс Telegram (настройки чата).
// Бот не может автоматически изменять стоимость Stars за сообщение.

// Кэш для порогов (обновляется раз в 30 секунд)
let thresholdsCache = null;
let thresholdsCacheTime = 0;
const THRESHOLDS_CACHE_TTL = 30000; // 30 секунд

// Функция для расчета динамических порогов на основе соотношения TONDEV и TON
// Формула: dump + pump = 1000, pump / dump = tondev / ton
async function calculateDynamicThresholds(useCache = true) {
  // Используем кэш если он еще актуален
  if (useCache && thresholdsCache && (Date.now() - thresholdsCacheTime) < THRESHOLDS_CACHE_TTL) {
    return thresholdsCache;
  }
  try {
    // Получаем seed фразу и создаем кошелек
    const seedPhrase = getSeedPhrase();
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    const wallet = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    const walletAddress = wallet.address;
    
    // Получаем балансы параллельно для ускорения
    const [tonBalanceResult, tondevBalanceResult] = await Promise.allSettled([
      // Получаем баланс TON
      (async () => {
        const response = await fetchWithRetry(
          `https://toncenter.com/api/v2/getAddressInformation?address=${walletAddress.toString()}`,
          {
            headers: { 'Accept': 'application/json' }
          },
          3,
          2000
        );
        const data = await response.json();
        return BigInt(data.result.balance || 0);
      })(),
      // Получаем баланс TONDEV
      getTondevBalance(walletAddress)
    ]);
    
    // Обрабатываем результаты
    let tonBalance = 0n;
    if (tonBalanceResult.status === 'fulfilled') {
      tonBalance = tonBalanceResult.value;
    } else {
      console.error(`[CALC_THRESHOLDS] ⚠️ Error getting TON balance:`, tonBalanceResult.reason?.message);
      // Используем значения по умолчанию (середина диапазона)
      return { 
        pumpThreshold: Math.round((MIN_PUMP_THRESHOLD + MAX_PUMP_THRESHOLD) / 2), 
        dumpThreshold: Math.round((MAX_DUMP_THRESHOLD + MIN_DUMP_THRESHOLD) / 2),
        tonBalance: 0,
        tondevBalance: 0
      };
    }
    
    let tondevBalance = 0n;
    if (tondevBalanceResult.status === 'fulfilled') {
      tondevBalance = tondevBalanceResult.value;
    } else {
      console.error(`[CALC_THRESHOLDS] ⚠️ Error getting TONDEV balance:`, tondevBalanceResult.reason?.message);
      // Если не удалось получить TONDEV баланс, используем 0
      tondevBalance = 0n;
    }
    
    // Конвертируем в числа для расчета
    const tonAmount = Number(tonBalance) / 1e9; // TON
    const tondevAmount = Number(tondevBalance) / 1e9; // TONDEV
    
    console.log(`[CALC_THRESHOLDS] 💰 TON balance: ${tonAmount.toFixed(4)} TON`);
    console.log(`[CALC_THRESHOLDS] 💎 TONDEV balance: ${tondevAmount.toFixed(4)} TONDEV`);
    
    // Рассчитываем пороги по формуле: pump / dump = tondev / ton
    // Ограничения: pump от 10 до 250, dump от 10 до 250 (в проверке будет отрицательное значение: от -250 до -10)
    let dumpThreshold, pumpThreshold;
    
    if (tondevAmount === 0 && tonAmount === 0) {
      // Если оба баланса 0, используем значения по умолчанию (середина диапазона)
      pumpThreshold = Math.round((MIN_PUMP_THRESHOLD + MAX_PUMP_THRESHOLD) / 2);
      dumpThreshold = Math.round((MAX_DUMP_THRESHOLD + MIN_DUMP_THRESHOLD) / 2);
    } else if (tondevAmount === 0) {
      // Если TONDEV = 0, то pump должен быть максимальным (250), dump минимальным (10)
      pumpThreshold = MAX_PUMP_THRESHOLD;
      dumpThreshold = MAX_DUMP_THRESHOLD;
    } else if (tonAmount === 0) {
      // Если TON = 0, то dump должен быть максимальным (250), pump минимальным (10)
      dumpThreshold = MIN_DUMP_THRESHOLD;
      pumpThreshold = MIN_PUMP_THRESHOLD;
    } else {
      // Формула на основе соотношения TONDEV/TON
      // Когда TONDEV мало относительно TON → pump большой (ближе к 250), dump маленький (ближе к 10)
      // Когда TONDEV много относительно TON → pump маленький (ближе к 10), dump большой (ближе к 250)
      const ratio = tondevAmount / tonAmount;
      
      // Используем обратную пропорцию для расчета
      // Нормализуем ratio: если ratio очень большой, ограничиваем его
      const maxRatio = 100; // Максимальное соотношение для расчета
      const normalizedRatio = Math.min(ratio, maxRatio) / maxRatio; // От 0 до 1
      
      // Pump: когда ratio маленький (TONDEV мало), pump должен быть большим
      pumpThreshold = Math.round(MIN_PUMP_THRESHOLD + (MAX_PUMP_THRESHOLD - MIN_PUMP_THRESHOLD) * (1 - normalizedRatio));
      
      // Dump: когда ratio большой (TONDEV много), dump должен быть большим
      dumpThreshold = Math.round(MAX_DUMP_THRESHOLD + (MIN_DUMP_THRESHOLD - MAX_DUMP_THRESHOLD) * normalizedRatio);
      
      // Применяем жесткие ограничения
      // Pump: от 10 до 250
      pumpThreshold = Math.max(MIN_PUMP_THRESHOLD, Math.min(MAX_PUMP_THRESHOLD, pumpThreshold));
      
      // Dump: от 10 до 250 (в проверке будет отрицательное значение: от -250 до -10)
      dumpThreshold = Math.max(MAX_DUMP_THRESHOLD, Math.min(MIN_DUMP_THRESHOLD, dumpThreshold));
    }
    
    console.log(`[CALC_THRESHOLDS] 📊 Calculated thresholds:`);
    console.log(`   Pump threshold: ${pumpThreshold} (TONDEV/TON ratio: ${tondevAmount > 0 && tonAmount > 0 ? (tondevAmount / tonAmount).toFixed(4) : 'N/A'})`);
    console.log(`   Dump threshold: ${dumpThreshold}`);
    console.log(`   Total: ${pumpThreshold + dumpThreshold}`);
    
    const result = { pumpThreshold, dumpThreshold, tonBalance: tonAmount, tondevBalance: tondevAmount };
    
    // Сохраняем в кэш
    thresholdsCache = result;
    thresholdsCacheTime = Date.now();
    
    return result;
  } catch (error) {
    console.error(`[CALC_THRESHOLDS] ❌ Error calculating thresholds:`, error.message);
    // Используем значения по умолчанию при ошибке (середина диапазона)
    return { pumpThreshold: Math.round((MIN_PUMP_THRESHOLD + MAX_PUMP_THRESHOLD) / 2), dumpThreshold: Math.round((MAX_DUMP_THRESHOLD + MIN_DUMP_THRESHOLD) / 2) };
  }
}

// ==================== BIDASK POOL CONFIGURATION ====================
const BIDASK_POOL_ADDRESS = 'EQDs6EBg0IfDk1FmWqy4vBdvYDJIM4r2bk9P8TUpu1lGhoOY'; // Адрес пула BidAsk для TONDEV
const TONDEV_JETTON_MASTER = 'EQDKMh511DOn02mL0nf0JrND0TlkUKmos17eK9zKyGAsjS1K'; // Jetton master адрес TONDEV
const BUY_AMOUNT_TON = process.env.BUY_AMOUNT_TON || '1'; // Сумма покупки в TON (по умолчанию 1 TON)
const MIN_TON_RESERVE = toNano('1'); // Минимальный резерв TON на кошельке (1 TON)

// ==================== WALLET CONFIGURATION ====================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'); // Ключ для шифрования seed фразы
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || crypto.randomBytes(16).toString('hex'); // IV для шифрования

// TON Client
// Для @ton/ton SDK используем публичные endpoints или настраиваем через HTTP API
// Если нужна авторизация, используем HTTP API напрямую для некоторых операций
const TON_API_KEY = process.env.TON_API_KEY;

// Используем публичный endpoint для основных операций
// Для операций требующих API ключ (если нужно), используем HTTP API напрямую
const tonClient = new TonClient({
  endpoint: 'https://toncenter.com/api/v2/jsonRPC'
  // API ключ передается через HTTP заголовки при необходимости
});

// Файлы для сохранения состояния
const STATE_FILE = path.join(__dirname, 'bot_state.json');

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
// Функция для retry запросов с экспоненциальной задержкой
async function fetchWithRetry(url, options = {}, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // Если получили 429 (rate limit), ждем и повторяем
      if (response.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt); // Экспоненциальная задержка: 1s, 2s, 4s
        console.log(`[FETCH] ⏳ Rate limit (429), waiting ${delay}ms before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Повторяем попытку
      }
      
      // Если другой статус ошибки, выбрасываем исключение
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      // Если это последняя попытка, выбрасываем ошибку
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      // Если это не 429 ошибка, но есть retry, ждем и повторяем
      if (!error.message.includes('429')) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[FETCH] ⚠️ Error: ${error.message}, retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error('Max retries exceeded');
}

// Шифрование seed фразы
function encryptSeedPhrase(seedPhrase) {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(ENCRYPTION_IV, 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(seedPhrase, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    // Логируем только тип ошибки, без деталей
    console.error(`[ENCRYPT] ❌ Error encrypting seed phrase:`, error.name || 'EncryptionError');
    throw new Error('Failed to encrypt seed phrase.');
  }
}

// Дешифрование seed фразы
function decryptSeedPhrase(encryptedData) {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const textParts = encryptedData.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    // Логируем только тип ошибки, без деталей, чтобы seed фраза не попала в логи
    console.error(`[DECRYPT] ❌ Error decrypting seed phrase:`, error.name || 'DecryptionError');
    // Выбрасываем общую ошибку без деталей
    throw new Error('Failed to decrypt seed phrase. Check ENCRYPTION_KEY and ENCRYPTION_IV.');
  }
}

// Получение seed фразы из переменных окружения
function getSeedPhrase() {
  const encryptedSeed = process.env.ENCRYPTED_WALLET_SEED;
  if (!encryptedSeed) {
    throw new Error('ENCRYPTED_WALLET_SEED is not set in environment variables');
  }
  return decryptSeedPhrase(encryptedSeed);
}

// Автоматическая покупка TONDEV через BidAsk пул
async function buyTondev(chatId) {
  try {
    console.log(`[BUY_TONDEV] 🔄 Starting automatic purchase...`);
    
    // Проверяем наличие необходимых переменных окружения
    if (!process.env.ENCRYPTED_WALLET_SEED) {
      throw new Error('ENCRYPTED_WALLET_SEED is not configured. Automatic purchase disabled.');
    }
    
    if (!process.env.TON_API_KEY) {
      throw new Error('TON_API_KEY is not configured. Required for blockchain interactions.');
    }
    
    // Получаем seed фразу
    const seedPhrase = getSeedPhrase();
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    
    // Создаем кошелек V5R1 (современный стандарт)
    const wallet = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    
    const walletContract = tonClient.open(wallet);
    const walletAddress = wallet.address;
    console.log(`[BUY_TONDEV] 📍 Wallet address: ${walletAddress.toString()}`);
    console.log(`[BUY_TONDEV] 🔗 View wallet: https://tonviewer.com/${walletAddress.toString()}`);
    
    // Получаем баланс кошелька через HTTP API с retry логикой
    let balance;
    let accountState = 'active';
    try {
      const response = await fetchWithRetry(
        `https://toncenter.com/api/v2/getAddressInformation?address=${walletAddress.toString()}`,
        {
          headers: { 'Accept': 'application/json' }
        },
        3, // max retries
        2000 // base delay 2 seconds
      );
      
      const data = await response.json();
      balance = BigInt(data.result.balance || 0);
      accountState = data.result.state || 'unknown';
      
      console.log(`[BUY_TONDEV] 💰 Account balance (raw): ${balance.toString()} nanoTON`);
      console.log(`[BUY_TONDEV] 💰 Account balance (TON): ${(Number(balance) / 1e9).toFixed(4)} TON`);
      console.log(`[BUY_TONDEV] 📊 Account state: ${accountState}`);
      
      // Если баланс 0, проверяем, может быть кошелек не инициализирован
      if (balance === 0n && accountState === 'uninit') {
        throw new Error('Wallet is not initialized. Please send at least 0.1 TON to activate it first.');
      }
      
    } catch (balanceError) {
      console.error(`[BUY_TONDEV] ❌ Error getting balance:`, balanceError.message);
      if (balanceError.message.includes('not initialized')) {
        throw balanceError;
      }
      throw new Error(`Failed to get wallet balance: ${balanceError.message}. Please check wallet address: ${walletAddress.toString()}`);
    }
    
    // Рассчитываем сумму для покупки: баланс - 1 TON (резерв)
    const buyAmountNano = balance - MIN_TON_RESERVE;
    const buyAmountTon = Number(buyAmountNano) / 1e9;
    
    console.log(`[BUY_TONDEV] 💰 Calculated buy amount: ${buyAmountTon.toFixed(4)} TON (balance - 1 TON reserve)`);
    
    // Проверяем, что есть достаточно средств для покупки (минимум 0.16 TON: 0.01 для swap + 0.15 для газа)
    const minRequiredForSwap = toNano('0.16'); // Минимум для swap с учетом газа
    if (buyAmountNano < minRequiredForSwap) {
      const balanceTon = (Number(balance) / 1e9).toFixed(4);
      throw new Error(`Insufficient balance for swap. Required: at least 0.16 TON for swap (balance - 1 TON reserve). Current balance: ${balanceTon} TON. Available: ${buyAmountTon.toFixed(4)} TON. Please check wallet: https://tonviewer.com/${walletAddress.toString()}`);
    }
    
    // Небольшая задержка перед получением seqno для избежания rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Получаем seqno с retry логикой
    let seqno;
    let seqnoAttempts = 0;
    const maxSeqnoAttempts = 3;
    while (seqnoAttempts < maxSeqnoAttempts) {
      try {
        seqno = await walletContract.getSeqno();
        break;
      } catch (seqnoError) {
        seqnoAttempts++;
        const errorMessage = seqnoError.message || String(seqnoError);
        
        // Если это rate limit ошибка (429), ждем и повторяем
        if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Too Many Requests')) {
          const delay = 2000 * Math.pow(2, seqnoAttempts - 1); // 2s, 4s, 8s
          console.log(`[BUY_TONDEV] ⏳ Rate limit on getSeqno, waiting ${delay}ms before retry ${seqnoAttempts}/${maxSeqnoAttempts}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Если это последняя попытка, выбрасываем исключение
        if (seqnoAttempts >= maxSeqnoAttempts) {
          throw new Error(`Failed to get seqno after ${maxSeqnoAttempts} attempts: ${errorMessage}`);
        }
        
        // Для других ошибок тоже делаем retry с задержкой
        const delay = 1000 * seqnoAttempts;
        console.log(`[BUY_TONDEV] ⚠️ Error getting seqno: ${errorMessage}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Адрес пула
    const poolAddress = Address.parse(BIDASK_POOL_ADDRESS);
    
    // Создаем сообщение для покупки (BidAsk swap)
    // Для покупки TONDEV нужно отправить TON в пул с вызовом метода swap
    // Структура сообщения для BidAsk: op=0xdd79732c (bidask_damm_swap)
    // В успешных транзакциях используется опкод 0xdd79732c, а не 0x2593855f
    const swapOp = 0xdd79732c; // bidask_damm_swap op code (правильный опкод)
    const queryId = BigInt(Date.now()); // Query ID - уникальный идентификатор
    
    // Создаем тело сообщения для swap используя Cell формат
    // Структура для BidAsk swap согласно успешным транзакциям:
    // op_code (32 бита) + query_id (64 бита) + native_amount (256 бит) + 
    // to_address (267 бит) + slippage (256 бит) + from_address (267 бит) + 
    // exact_out (1 бит) + additional_data (Cell) + reject_payload (Cell или null) + forward_payload (Cell или null)
    // ВАЖНО: native_amount для swap должен быть меньше суммы отправки на ~0.015 TON (газ)
    // Используем 0.15 TON для гарантии
    // buyAmountTon уже рассчитан выше как баланс - 1 TON (резерв)
    const gasReserve = 0.15; // Резерв на газ (0.15 TON)
    const swapAmountTon = buyAmountTon - gasReserve; // Сумма для swap (меньше на газ)
    
    if (swapAmountTon <= 0) {
      throw new Error(`Calculated buy amount (${buyAmountTon.toFixed(4)} TON) слишком мал для swap. Минимум: ${gasReserve + 0.01} TON`);
    }
    
    // ВАЖНО: Используем toFixed(9) для правильного форматирования числа перед передачей в toNano()
    // Это предотвращает ошибку "Invalid number" при конвертации
    const swapAmountTonFixed = parseFloat(swapAmountTon.toFixed(9)); // Округляем до 9 знаков после запятой
    const nativeAmount = toNano(swapAmountTonFixed.toString()); // Сумма TON для swap (с учетом газа)
    const toAddress = walletAddress; // Адрес получателя (наш кошелек для получения TONDEV)
    
    // Slippage: минимальное количество токенов на выходе (в нанотокенах jetton)
    // В успешной транзакции slippage = 1608511224 для 0.1 TON (native_amount = 100000000)
    // Рассчитываем пропорционально нашему native_amount
    const slippageRatio = Number(nativeAmount) / 100000000; // Коэффициент относительно 0.1 TON
    const slippage = BigInt(Math.floor(1608511224 * slippageRatio)); // Пропорциональный slippage
    
    const fromAddress = walletAddress; // Адрес отправителя (наш кошелек)
    const exactOut = 0n; // exact_out: coins (0 если нет exact_out)
    
    // Additional data: ref_addr (address) + ref_fee (uint16)
    // В успешной транзакции additional_data = null (отсутствует)
    // Не используем реферальную систему, поэтому additional_data отсутствует
    
    // Создаем тело сообщения согласно документации BidAsk для native swap
    // Структура согласно документации и успешной транзакции:
    // 1. op: uint32 (0xdd79732c)
    // 2. query_id: uint64
    // 3. native_amount: coins
    // 4. to_address: address
    // 5. slippage: coins (minimum amount of token out)
    // 6. from_address: address
    // 7. exact_out: coins (0 if no exact_out present)
    // 8. additional_data @ maybe: отсутствует (бит 0 = null)
    // 9. reject_payload: maybe_cell - отсутствует (бит 0 = null)
    // 10. forward_payload: maybe_cell - отсутствует (бит 0 = null)
    const swapBody = beginCell()
      .storeUint(swapOp, 32)           // 1. op: uint32 (0xdd79732c)
      .storeUint(queryId, 64)          // 2. query_id: uint64
      .storeCoins(nativeAmount)        // 3. native_amount: coins
      .storeAddress(toAddress)         // 4. to_address: address
      .storeCoins(slippage)            // 5. slippage: coins (minimum amount of token out)
      .storeAddress(fromAddress)       // 6. from_address: address
      .storeCoins(exactOut)            // 7. exact_out: coins (0 if no exact_out present)
      .storeBit(0)                     // 8. additional_data отсутствует (maybe: бит 0 = null)
      .storeBit(0)                     // 9. reject_payload отсутствует (maybe_cell: бит 0 = null)
      .storeBit(0)                     // 10. forward_payload отсутствует (maybe_cell: бит 0 = null)
      .endCell();
    
    console.log(`[BUY_TONDEV] 💰 Buying ${swapAmountTon.toFixed(4)} TON worth of TONDEV (gas reserve: ${gasReserve} TON)`);
    
    // Создаем внутреннее сообщение
    // Для покупки TONDEV отправляем TON в пул, сумма покупки указывается в value
    const buyMessage = internal({
      to: poolAddress,
      value: buyAmountNano, // Полная сумма TON для отправки (баланс - 1 TON резерв, включая газ)
      body: swapBody, // В body native_amount уже меньше на 0.15 TON
      bounce: true, // Отскакивать - стандарт для swap операций
    });
    
    // Небольшая задержка перед отправкой транзакции для избежания rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Отправляем транзакцию через sendExternalMessage
    // Это стандартный способ для @ton/ton SDK
    const transfer = walletContract.createTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [buyMessage],
    });
    
    // Отправка с retry логикой
    let sendAttempts = 0;
    const maxSendAttempts = 3;
    while (sendAttempts < maxSendAttempts) {
      try {
        await tonClient.sendExternalMessage(wallet, transfer);
        console.log(`[BUY_TONDEV] ✅ Purchase transaction sent successfully`);
        break;
      } catch (sendError) {
        sendAttempts++;
        const errorMessage = sendError.message || String(sendError);
        
        // Если это rate limit ошибка (429), ждем и повторяем
        if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Too Many Requests')) {
          const delay = 2000 * Math.pow(2, sendAttempts - 1); // 2s, 4s, 8s
          console.log(`[BUY_TONDEV] ⏳ Rate limit detected, waiting ${delay}ms before retry ${sendAttempts}/${maxSendAttempts}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Если это последняя попытка или другая ошибка, выбрасываем исключение
        if (sendAttempts >= maxSendAttempts) {
          throw new Error(`Failed to send transaction after ${maxSendAttempts} attempts: ${errorMessage}`);
        }
        
        // Для других ошибок тоже делаем retry с задержкой
        const delay = 1000 * sendAttempts;
        console.log(`[BUY_TONDEV] ⚠️ Error sending transaction: ${errorMessage}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Ждем перед проверкой баланса (транзакция должна быть обработана блокчейном)
    // Используем retry логику с увеличивающимися задержками
    console.log(`[BUY_TONDEV] ⏳ Waiting for TONDEV tokens to arrive...`);
    
    let tondevBalance = 0n;
    let balanceCheckAttempts = 0;
    const maxBalanceCheckAttempts = 6; // Проверяем до 6 раз
    const initialDelay = 10000; // Начальная задержка 10 секунд
    
    while (balanceCheckAttempts < maxBalanceCheckAttempts) {
      try {
        // Увеличиваем задержку с каждой попыткой: 10s, 15s, 20s, 25s, 30s, 35s
        const delay = initialDelay + (balanceCheckAttempts * 5000);
        if (balanceCheckAttempts > 0) {
          console.log(`[BUY_TONDEV] ⏳ Retry ${balanceCheckAttempts}/${maxBalanceCheckAttempts - 1}, waiting ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        tondevBalance = await getTondevBalance(walletAddress);
        const tondevBalanceFormatted = (Number(tondevBalance) / 1e9).toFixed(4);
        
        if (tondevBalance > 0n) {
          console.log(`[BUY_TONDEV] ✅ TONDEV tokens received: ${tondevBalanceFormatted} TONDEV`);
          
          // Отправляем уведомление об успешной покупке с балансом
          await bot.sendMessage(
            chatId,
            `✅ <b>Автоматическая покупка TONDEV выполнена!</b>\n\n` +
            `💰 Отправлено: ${BUY_AMOUNT_TON} TON\n` +
            `💎 Swap: ${swapAmountTon.toFixed(4)} TON (с учетом газа)\n` +
            `💎 Получено: ${tondevBalanceFormatted} TONDEV\n` +
            `📍 Пул: <code>${BIDASK_POOL_ADDRESS}</code>\n` +
            `🔗 <a href="https://tonviewer.com/${walletAddress.toString()}">Просмотр кошелька</a>`,
            { parse_mode: 'HTML' }
          );
          break; // Выходим из цикла, если токены получены
        } else {
          balanceCheckAttempts++;
          console.log(`[BUY_TONDEV] ⏳ TONDEV balance is still 0, attempt ${balanceCheckAttempts}/${maxBalanceCheckAttempts}`);
        }
      } catch (balanceError) {
        balanceCheckAttempts++;
        console.error(`[BUY_TONDEV] ⚠️ Error checking TONDEV balance (attempt ${balanceCheckAttempts}):`, balanceError.message);
        
        if (balanceCheckAttempts >= maxBalanceCheckAttempts) {
          // Если все попытки исчерпаны, отправляем уведомление о том, что транзакция отправлена
          await bot.sendMessage(
            chatId,
            `✅ <b>Транзакция отправлена</b>\n\n` +
            `💰 Отправлено: ${buyAmountTon.toFixed(4)} TON (баланс - 1 TON резерв)\n` +
            `💎 Swap: ${swapAmountTon.toFixed(4)} TON (с учетом газа)\n` +
            `📍 Пул: <code>${BIDASK_POOL_ADDRESS}</code>\n` +
            `🔗 <a href="https://tonviewer.com/${walletAddress.toString()}">Проверить кошелек</a>\n\n` +
            `⚠️ Не удалось проверить баланс TONDEV автоматически. Проверьте вручную.`,
            { parse_mode: 'HTML' }
          );
        }
      }
    }
    
    // Если токены так и не получены после всех попыток
    if (tondevBalance === 0n && balanceCheckAttempts >= maxBalanceCheckAttempts) {
      console.log(`[BUY_TONDEV] ⚠️ TONDEV balance is still 0 after ${maxBalanceCheckAttempts} attempts`);
      // Уведомление уже отправлено выше
    }
    
    return true;
  } catch (error) {
    console.error(`[BUY_TONDEV] ❌ Error during purchase:`, error.message);
    
    // Отправляем сообщение об ошибке в чат
    try {
      await bot.sendMessage(
        chatId,
        `❌ <b>Ошибка при автоматической покупке TONDEV</b>\n\n` +
        `Ошибка: <code>${error.message}</code>\n\n` +
        `Проверьте логи бота для подробностей.`,
        { parse_mode: 'HTML' }
      );
    } catch (sendError) {
      console.error(`[BUY_TONDEV] ❌ Failed to send error message:`, sendError.message);
    }
    
    return false;
  }
}

// Получение адреса jetton wallet пользователя
async function getJettonWalletAddress(userWalletAddress) {
  let attempts = 0;
  const maxAttempts = 5;
  
  while (attempts < maxAttempts) {
    try {
      const jettonMasterAddress = Address.parse(TONDEV_JETTON_MASTER);
      const jettonMaster = tonClient.open(JettonMaster.create(jettonMasterAddress));
      const jettonWalletAddress = await jettonMaster.getWalletAddress(userWalletAddress);
      console.log(`[GET_JETTON_WALLET] ✅ Jetton wallet address: ${jettonWalletAddress.toString()}`);
      return jettonWalletAddress;
    } catch (error) {
      attempts++;
      const errorMessage = error.message || String(error);
      const errorString = JSON.stringify(error);
      
      // Проверяем rate limit ошибку более тщательно
      const isRateLimit = errorMessage.includes('429') || 
                         errorMessage.includes('rate limit') || 
                         errorMessage.includes('Too Many Requests') ||
                         errorString.includes('429') ||
                         error.status === 429 ||
                         error.statusCode === 429;
      
      if (isRateLimit) {
        // Увеличиваем задержку для rate limit: 5s, 10s, 20s, 40s, 60s
        const delay = Math.min(5000 * Math.pow(2, attempts - 1), 60000);
        console.log(`[GET_JETTON_WALLET] ⏳ Rate limit (429), waiting ${delay/1000}s before retry ${attempts}/${maxAttempts}...`);
        
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error(`Failed to get jetton wallet address after ${maxAttempts} attempts due to rate limit (429). Please try again later.`);
        }
      }
      
      // Если это последняя попытка, выбрасываем исключение
      if (attempts >= maxAttempts) {
        console.error(`[GET_JETTON_WALLET] ❌ Error getting jetton wallet address after ${maxAttempts} attempts:`, errorMessage);
        throw error;
      }
      
      // Для других ошибок делаем retry с меньшей задержкой
      const delay = 2000 * attempts; // 2s, 4s, 6s, 8s
      console.log(`[GET_JETTON_WALLET] ⚠️ Error getting jetton wallet address: ${errorMessage}, retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('Max retries exceeded for getJettonWalletAddress');
}

// Получение баланса TONDEV токенов
async function getTondevBalance(userWalletAddress) {
  try {
    const jettonWalletAddress = await getJettonWalletAddress(userWalletAddress);
    
    // Пробуем получить баланс через SDK метод getBalance()
    try {
      const jettonWallet = tonClient.open(JettonWallet.create(jettonWalletAddress));
      const balance = await jettonWallet.getBalance();
      if (balance > 0n) {
        console.log(`[GET_TONDEV_BALANCE] ✅ Balance: ${(Number(balance) / 1e9).toFixed(4)} TONDEV`);
        return balance;
      }
    } catch (sdkError) {
      // Продолжаем к альтернативному методу
    }
    
    // Альтернативный метод: через runMethod get_wallet_data с retry логикой
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (attempt > 0) {
          const delay = 2000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const result = await tonClient.runMethod(jettonWalletAddress, 'get_wallet_data');
        
        if (result.stack && typeof result.stack.readBigNumber === 'function') {
          const balance = result.stack.readBigNumber();
          if (balance > 0n) {
            console.log(`[GET_TONDEV_BALANCE] ✅ Balance: ${(Number(balance) / 1e9).toFixed(4)} TONDEV`);
            return balance;
          }
          break;
        }
      } catch (error) {
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('Too Many Requests')) {
          if (attempt < 4) continue;
        }
        if (attempt === 4) break;
      }
    }
    
    return 0n;
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('does not exist') || error.message.includes('not initialized')) {
      return 0n;
    }
    throw error;
  }
}

// Автоматическая продажа всех TONDEV токенов через BidAsk пул
async function sellTondev(chatId) {
  try {
    console.log(`[SELL_TONDEV] 🔄 Starting automatic sale of all TONDEV tokens...`);
    
    // Проверяем наличие необходимых переменных окружения
    if (!process.env.ENCRYPTED_WALLET_SEED) {
      throw new Error('ENCRYPTED_WALLET_SEED is not configured. Automatic sale disabled.');
    }
    
    if (!process.env.TON_API_KEY) {
      throw new Error('TON_API_KEY is not configured. Required for blockchain interactions.');
    }
    
    // Получаем seed фразу
    const seedPhrase = getSeedPhrase();
    const keyPair = await mnemonicToWalletKey(seedPhrase.split(' '));
    
    // Создаем кошелек V5R1 (современный стандарт)
    const wallet = WalletContractV5R1.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    
    const walletContract = tonClient.open(wallet);
    const userWalletAddress = wallet.address;
    
    // Небольшая задержка перед получением jetton wallet для избежания rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Получаем адрес jetton wallet (нужен для продажи) с retry логикой для rate limit
    const jettonWalletAddress = await getJettonWalletAddress(userWalletAddress);
    console.log(`[SELL_TONDEV] 📍 Jetton wallet: ${jettonWalletAddress.toString()}`);
    
    // Получаем баланс TONDEV токенов
    // getTondevBalance уже пробует несколько методов с retry логикой
    let tondevBalance = await getTondevBalance(userWalletAddress);
    const tondevBalanceFormatted = (Number(tondevBalance) / 1e9).toFixed(4);
    console.log(`[SELL_TONDEV] 💎 TONDEV balance (raw): ${tondevBalance.toString()} nanoTONDEV (${tondevBalanceFormatted} TONDEV)`);
    
    // Если баланс 0 после всех попыток, выбрасываем ошибку
    if (tondevBalance === 0n) {
      throw new Error(`No TONDEV tokens to sell. Balance is 0. Please check jetton wallet manually: https://tonviewer.com/${jettonWalletAddress.toString()}`);
    }
    
    // Округляем баланс до 3 знаков после запятой, чтобы не отправлять больше чем есть
    const tondevBalanceTon = Number(tondevBalance) / 1e9;
    const tondevBalanceTonRounded = Math.floor(tondevBalanceTon * 1000) / 1000;
    tondevBalance = BigInt(Math.floor(tondevBalanceTonRounded * 1e9));
    
    // Небольшая задержка перед получением seqno для избежания rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Получаем seqno с retry логикой для rate limit
    let seqno;
    let seqnoAttempts = 0;
    const maxSeqnoAttempts = 5; // Увеличено до 5 попыток
    while (seqnoAttempts < maxSeqnoAttempts) {
      try {
        seqno = await walletContract.getSeqno();
        break;
      } catch (seqnoError) {
        seqnoAttempts++;
        const errorMessage = seqnoError.message || String(seqnoError);
        const errorString = JSON.stringify(seqnoError);
        
        // Проверяем rate limit ошибку более тщательно
        const isRateLimit = errorMessage.includes('429') || 
                           errorMessage.includes('rate limit') || 
                           errorMessage.includes('Too Many Requests') ||
                           errorString.includes('429') ||
                           seqnoError.status === 429 ||
                           seqnoError.statusCode === 429;
        
        if (isRateLimit) {
          // Увеличиваем задержку для rate limit: 5s, 10s, 20s, 40s, 60s
          const delay = Math.min(5000 * Math.pow(2, seqnoAttempts - 1), 60000);
          console.log(`[SELL_TONDEV] ⏳ Rate limit (429) on getSeqno, waiting ${delay/1000}s before retry ${seqnoAttempts}/${maxSeqnoAttempts}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          if (seqnoAttempts < maxSeqnoAttempts) {
            continue;
          } else {
            throw new Error(`Failed to get seqno after ${maxSeqnoAttempts} attempts due to rate limit (429). Please try again later.`);
          }
        }
        
        // Если это последняя попытка, выбрасываем исключение
        if (seqnoAttempts >= maxSeqnoAttempts) {
          throw new Error(`Failed to get seqno after ${maxSeqnoAttempts} attempts: ${errorMessage}`);
        }
        
        // Для других ошибок делаем retry с меньшей задержкой
        const delay = 2000 * seqnoAttempts; // 2s, 4s, 6s, 8s
        console.log(`[SELL_TONDEV] ⚠️ Error getting seqno: ${errorMessage}, retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Адрес пула
    const poolAddress = Address.parse(BIDASK_POOL_ADDRESS);
    
    // Создаем сообщение для продажи (BidAsk swap)
    // Для продажи TONDEV нужно отправить jetton transfer в пул с swap сообщением в forward_payload
    // 
    // СРАВНЕНИЕ С ДОКУМЕНТАЦИЕЙ:
    // Native swap (покупка): op + query_id + native_amount + to_address + slippage + from_address + exact_out + additional_data + reject_payload + forward_payload
    // Jetton swap (продажа): swap в forward_payload jetton transfer
    // 
    // СРАВНЕНИЕ С ОШИБОЧНОЙ ТРАНЗАКЦИЕЙ:
    // Структура была: op + to_address + slippage + from_address + exact_out (БЕЗ query_id и native_amount)
    // Это правильно для jetton swap в forward_payload - query_id идет в jetton transfer, а не в swap body
    // 
    // Но возможно проблема в порядке полей или в других параметрах
    const swapOp = 0xdd79732c; // bidask_damm_swap op code (тот же, что и для покупки)
    const queryId = BigInt(Date.now()); // Уникальный query ID для jetton transfer (НЕ включается в swap body)
    
    // Параметры для swap при продаже
    // ВАЖНО: to_address должен быть адресом кошелька, куда пул отправит TON после swap
    const toAddress = userWalletAddress; // Адрес получателя TON (наш кошелек) - ВАЖНО: это адрес кошелька!
    console.log(`[SELL_TONDEV] 🔍 Wallet address for to_address: ${userWalletAddress.toString()}`);
    // Slippage: минимальное количество TON на выходе (в нанотокенах)
    // В ошибочной транзакции slippage был "743035754" (примерно 0.743 TON) для 74.304 TONDEV
    // Это примерно 1% от ожидаемого количества TON
    // Рассчитываем slippage как 1% от ожидаемого количества TON
    const expectedTonOut = tondevBalance; // Примерно столько же TON (1:1 курс примерно)
    let slippage = expectedTonOut / BigInt(100); // 1% slippage
    
    // Минимальный slippage: 0.01 TON (10,000,000 nanoTON) для очень маленьких сумм
    // Это предотвращает slippage = 0 при очень маленьких балансах
    const MIN_SLIPPAGE = toNano('0.01'); // 0.01 TON минимум
    if (slippage < MIN_SLIPPAGE) {
      slippage = MIN_SLIPPAGE;
      console.log(`[SELL_TONDEV] ⚠️ Calculated slippage too small, using minimum: ${(Number(slippage) / 1e9).toFixed(4)} TON`);
    }
    
    console.log(`[SELL_TONDEV] 💰 Expected TON out: ${(Number(expectedTonOut) / 1e9).toFixed(4)} TON`);
    console.log(`[SELL_TONDEV] 📉 Slippage: ${(Number(slippage) / 1e9).toFixed(4)} TON`);
    
    const fromAddress = userWalletAddress; // Адрес отправителя (наш кошелек)
    const exactOut = 0n; // exact_out: coins (0 если нет exact_out)
    
    if (!toAddress || !fromAddress || slippage === 0n) {
      throw new Error(`Invalid swap parameters: toAddress=${toAddress}, fromAddress=${fromAddress}, slippage=${slippage}`);
    }
    
    const swapBody = beginCell()
      .storeUint(swapOp, 32)
      .storeAddress(userWalletAddress)
      .storeCoins(slippage)
      .storeAddress(userWalletAddress)
      .storeCoins(exactOut)
      .storeBit(0)
      .storeBit(0)
      .storeBit(0)
      .endCell();
    
    // Создаем сообщение для jetton transfer
    // Структура jetton transfer: op=0xf8a7ea5 (transfer), query_id, amount, destination, response_destination, custom_payload, forward_ton_amount, forward_payload
    const transferOp = 0xf8a7ea5; // jetton transfer op code
    // ВАЖНО: forward_ton_amount должен быть достаточным для выполнения swap в пуле
    // В успешной транзакции видно, что отправляется TON вместе с jetton transfer
    // Exit code 48 обычно означает недостаточный баланс TON на jetton wallet
    // Увеличиваем forward_ton_amount для гарантии выполнения swap
    // Нужно достаточно TON для газа при выполнении swap в пуле
    const forwardTonAmount = toNano('0.3'); // Комиссия для форварда и газа (увеличено до 0.3 TON для надежности)
    
    // Создаем jetton transfer body с swap сообщением в forward_payload
    // СРАВНЕНИЕ С ОШИБОЧНОЙ ТРАНЗАКЦИЕЙ:
    // response_destination был установлен на userWalletAddress, но возможно должен быть null
    // В ошибочной транзакции response_destination был 0:13efaf8250c7d3c9f029047317727f4e82f644ec7ae5354c2f46de54e911a7fe
    // Попробуем установить null для response_destination
    const jettonTransferBody = beginCell()
      .storeUint(transferOp, 32)           // op code для jetton transfer
      .storeUint(queryId, 64)              // query_id
      .storeCoins(tondevBalance)           // amount - все токены
      .storeAddress(poolAddress)           // destination - адрес пула
      .storeAddress(null)                   // response_destination - null (пул отправит TON на to_address из swap)
      .storeBit(0)                         // custom_payload отсутствует (null)
      .storeCoins(forwardTonAmount)        // forward_ton_amount
      .storeBit(1)                         // forward_payload присутствует
      .storeRef(swapBody)                  // forward_payload содержит swap сообщение для BidAsk
      .endCell();
    
    // Создаем внутреннее сообщение для отправки jetton transfer
    // ВАЖНО: Это jetton transfer, а не TON transfer!
    // Мы отправляем сообщение на jetton wallet адрес с телом jetton transfer
    // value - это комиссия в TON для выполнения jetton transfer (не сумма продажи!)
    // Сами TONDEV токены указываются в jettonTransferBody (amount: tondevBalance)
    // Exit code 48 обычно означает недостаточный баланс TON на jetton wallet
    // Увеличиваем value для гарантии выполнения jetton transfer и swap (нужно больше TON на jetton wallet)
    // value должен покрывать: комиссию за jetton transfer + forward_ton_amount + газ
    const sellMessage = internal({
      to: jettonWalletAddress, // Адрес jetton wallet (не пул!)
      value: toNano('0.5'), // Комиссия в TON для выполнения jetton transfer и swap (увеличено до 0.5 TON для покрытия всех расходов)
      body: jettonTransferBody, // Тело jetton transfer с количеством TONDEV токенов
      bounce: true,
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Отправляем транзакцию через sendExternalMessage
    const transfer = walletContract.createTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [sellMessage],
    });
    
    // Отправка с retry логикой для rate limit
    let sendAttempts = 0;
    const maxSendAttempts = 5; // Увеличено до 5 попыток
    while (sendAttempts < maxSendAttempts) {
      try {
        await tonClient.sendExternalMessage(wallet, transfer);
        console.log(`[SELL_TONDEV] ✅ Transaction sent successfully on attempt ${sendAttempts + 1}`);
        break;
      } catch (sendError) {
        sendAttempts++;
        const errorMessage = sendError.message || String(sendError);
        const errorString = JSON.stringify(sendError);
        
        // Проверяем rate limit ошибку более тщательно
        const isRateLimit = errorMessage.includes('429') || 
                           errorMessage.includes('rate limit') || 
                           errorMessage.includes('Too Many Requests') ||
                           errorString.includes('429') ||
                           sendError.status === 429 ||
                           sendError.statusCode === 429;
        
        if (isRateLimit) {
          // Увеличиваем задержку для rate limit: 5s, 10s, 20s, 40s, 60s
          const delay = Math.min(5000 * Math.pow(2, sendAttempts - 1), 60000);
          console.log(`[SELL_TONDEV] ⏳ Rate limit (429) detected, waiting ${delay/1000}s before retry ${sendAttempts}/${maxSendAttempts}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          if (sendAttempts < maxSendAttempts) {
            continue; // Продолжаем попытки
          } else {
            throw new Error(`Failed to send transaction after ${maxSendAttempts} attempts due to rate limit (429). Please try again later.`);
          }
        }
        
        // Если это последняя попытка, выбрасываем исключение
        if (sendAttempts >= maxSendAttempts) {
          throw new Error(`Failed to send transaction after ${maxSendAttempts} attempts: ${errorMessage}`);
        }
        
        // Для других ошибок делаем retry с меньшей задержкой
        const delay = 2000 * sendAttempts; // 2s, 4s, 6s, 8s
        console.log(`[SELL_TONDEV] ⚠️ Error sending transaction: ${errorMessage}, retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    const tondevAmount = (Number(tondevBalance) / 1e9).toFixed(4);
    console.log(`[SELL_TONDEV] ✅ Sale transaction sent successfully`);
    console.log(`[SELL_TONDEV] 💎 Amount: ${tondevAmount} TONDEV`);
    console.log(`[SELL_TONDEV] 📍 Pool: ${BIDASK_POOL_ADDRESS}`);
    
    // Ждем перед проверкой баланса TON (транзакция должна быть обработана блокчейном)
    // Используем retry логику с увеличивающимися задержками
    console.log(`[SELL_TONDEV] ⏳ Waiting for TON to arrive...`);
    
    let tonBalanceAfterSale = 0n;
    let balanceCheckAttempts = 0;
    const maxBalanceCheckAttempts = 6; // Проверяем до 6 раз
    const initialDelay = 10000; // Начальная задержка 10 секунд
    
    // Получаем начальный баланс TON для сравнения
    let initialTonBalance;
    try {
      const response = await fetchWithRetry(
        `https://toncenter.com/api/v2/getAddressInformation?address=${userWalletAddress.toString()}`,
        {
          headers: { 'Accept': 'application/json' }
        },
        3,
        2000
      );
      const data = await response.json();
      initialTonBalance = BigInt(data.result.balance || 0);
      console.log(`[SELL_TONDEV] 💰 Initial TON balance: ${(Number(initialTonBalance) / 1e9).toFixed(4)} TON`);
    } catch (error) {
      console.error(`[SELL_TONDEV] ⚠️ Error getting initial balance:`, error.message);
    }
    
    while (balanceCheckAttempts < maxBalanceCheckAttempts) {
      try {
        // Увеличиваем задержку с каждой попыткой: 10s, 15s, 20s, 25s, 30s, 35s
        const delay = initialDelay + (balanceCheckAttempts * 5000);
        if (balanceCheckAttempts > 0) {
          console.log(`[SELL_TONDEV] ⏳ Retry ${balanceCheckAttempts}/${maxBalanceCheckAttempts - 1}, waiting ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Получаем текущий баланс TON
        const response = await fetchWithRetry(
          `https://toncenter.com/api/v2/getAddressInformation?address=${userWalletAddress.toString()}`,
          {
            headers: { 'Accept': 'application/json' }
          },
          3,
          2000
        );
        const data = await response.json();
        tonBalanceAfterSale = BigInt(data.result.balance || 0);
        const tonBalanceFormatted = (Number(tonBalanceAfterSale) / 1e9).toFixed(4);
        
        // Проверяем, увеличился ли баланс TON (токены были проданы)
        if (initialTonBalance && tonBalanceAfterSale > initialTonBalance) {
          const receivedTon = (Number(tonBalanceAfterSale - initialTonBalance) / 1e9).toFixed(4);
          console.log(`[SELL_TONDEV] ✅ TON received: ${receivedTon} TON`);
          
          // Отправляем уведомление об успешной продаже с балансом
          await bot.sendMessage(
            chatId,
            `✅ <b>Автоматическая продажа TONDEV выполнена!</b>\n\n` +
            `💎 Продано: ${tondevAmount} TONDEV\n` +
            `💰 Получено: ${receivedTon} TON\n` +
            `📍 Пул: <code>${BIDASK_POOL_ADDRESS}</code>\n` +
            `🔗 <a href="https://tonviewer.com/${userWalletAddress.toString()}">Просмотр кошелька</a>`,
            { parse_mode: 'HTML' }
          );
          break; // Выходим из цикла, если TON получен
        } else {
          balanceCheckAttempts++;
          console.log(`[SELL_TONDEV] ⏳ TON balance hasn't increased yet, attempt ${balanceCheckAttempts}/${maxBalanceCheckAttempts}`);
        }
      } catch (balanceError) {
        balanceCheckAttempts++;
        console.error(`[SELL_TONDEV] ⚠️ Error checking TON balance (attempt ${balanceCheckAttempts}):`, balanceError.message);
        
        if (balanceCheckAttempts >= maxBalanceCheckAttempts) {
          // Если все попытки исчерпаны, отправляем уведомление о том, что транзакция отправлена
          await bot.sendMessage(
            chatId,
            `✅ <b>Транзакция продажи отправлена</b>\n\n` +
            `💎 Продано: ${tondevAmount} TONDEV\n` +
            `📍 Пул: <code>${BIDASK_POOL_ADDRESS}</code>\n` +
            `🔗 <a href="https://tonviewer.com/${userWalletAddress.toString()}">Проверить кошелек</a>\n\n` +
            `⚠️ Не удалось проверить баланс TON автоматически. Проверьте вручную.`,
            { parse_mode: 'HTML' }
          );
        }
      }
    }
    
    // Если TON так и не получен после всех попыток
    if (initialTonBalance && tonBalanceAfterSale <= initialTonBalance && balanceCheckAttempts >= maxBalanceCheckAttempts) {
      console.log(`[SELL_TONDEV] ⚠️ TON balance hasn't increased after ${maxBalanceCheckAttempts} attempts`);
      // Уведомление уже отправлено выше
    }
    
    return true;
  } catch (error) {
    console.error(`[SELL_TONDEV] ❌ Error during sale:`, error.message);
    
    // Отправляем сообщение об ошибке в чат
    try {
      await bot.sendMessage(
        chatId,
        `❌ <b>Ошибка при автоматической продаже TONDEV</b>\n\n` +
        `Ошибка: <code>${error.message}</code>\n\n` +
        `Проверьте логи бота для подробностей.`,
        { parse_mode: 'HTML' }
      );
    } catch (sendError) {
      console.error(`[SELL_TONDEV] ❌ Failed to send error message:`, sendError.message);
    }
    
    return false;
  }
}

// Проверка, является ли пользователь администратором чата
async function isAdmin(chatId, userId) {
  try {
    // В приватных чатах все пользователи - админы
    if (chatId > 0) {
      return true;
    }
    
    // В группах/каналах проверяем права
    const member = await bot.getChatMember(chatId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch (error) {
    console.error(`[isAdmin] Error checking admin status:`, error.message);
    return false;
  }
}

// Быстрое неблокирующее сохранение состояния
// Сохраняем сразу, но не ждем завершения (fire and forget)
let saveStateQueue = Promise.resolve();
let saveStateCounter = 0;

function normalizeInventoryEntry(entry = {}) {
  const normalized = {};
  for (const itemKey of Object.keys(STORE_ITEMS)) {
    const value = Number(entry[itemKey]);
    if (!Number.isNaN(value) && value > 0) {
      normalized[itemKey] = value;
    }
  }
  return normalized;
}

function getUserInventory(userId) {
  if (!userId) return {};
  if (!userInventory[userId]) {
    userInventory[userId] = {};
  }
  return userInventory[userId];
}

function getInventoryCount(userId, itemId) {
  return userInventory[userId]?.[itemId] || 0;
}

function addInventoryItem(userId, itemId, amount = 1) {
  if (!STORE_ITEMS[itemId] || !userId) return;
  const inventory = getUserInventory(userId);
  inventory[itemId] = (inventory[itemId] || 0) + amount;
  saveState();
}

function consumeInventoryItem(userId, itemId) {
  if (!STORE_ITEMS[itemId] || !userId) return false;
  const inventory = getUserInventory(userId);
  if ((inventory[itemId] || 0) <= 0) {
    return false;
  }
  inventory[itemId] -= 1;
  if (inventory[itemId] <= 0) {
    delete inventory[itemId];
  }
  saveState();
  return true;
}

function saveState() {
  saveStateCounter++;
  const currentCounter = saveStateCounter;
  
  // Добавляем в очередь, но не блокируем выполнение
  saveStateQueue = saveStateQueue.then(async () => {
    try {
      const inventoryForSave = {};
      for (const [userId, items] of Object.entries(userInventory)) {
        const normalized = normalizeInventoryEntry(items);
        if (Object.keys(normalized).length > 0) {
          inventoryForSave[userId] = normalized;
        }
      }

      const state = {
        pumpDumpEvent: {
          isActive: pumpDumpEvent.isActive,
          finishResult: pumpDumpEvent.finishResult,
          pumpThreshold: pumpDumpEvent.pumpThreshold !== null && pumpDumpEvent.pumpThreshold !== undefined ? pumpDumpEvent.pumpThreshold : null,
          dumpThreshold: pumpDumpEvent.dumpThreshold !== null && pumpDumpEvent.dumpThreshold !== undefined ? pumpDumpEvent.dumpThreshold : null,
          pinnedMessageId: pumpDumpEvent.pinnedMessageId !== null && pumpDumpEvent.pinnedMessageId !== undefined ? pumpDumpEvent.pinnedMessageId : null,
          eventChatId: pumpDumpEvent.eventChatId !== null && pumpDumpEvent.eventChatId !== undefined ? pumpDumpEvent.eventChatId : null
        },
        userInventory: inventoryForSave
      };
      
      // Сохраняем синхронно, но в фоне (не блокируем основной поток)
      await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
      
      // Логируем только каждую 10-ю операцию для производительности
      if (currentCounter % 10 === 0) {
        console.log(`[SAVE_STATE] ✅ State saved (${currentCounter}): event active: ${pumpDumpEvent.isActive}, finishResult: ${pumpDumpEvent.finishResult}, pumpThreshold: ${pumpDumpEvent.pumpThreshold}, dumpThreshold: ${pumpDumpEvent.dumpThreshold}`);
      }
    } catch (error) {
      console.error(`[SAVE_STATE] ❌ Error saving state:`, error.message);
    }
  }).catch(err => {
    console.error(`[SAVE_STATE] ❌ Error in save queue:`, err.message);
  });
  
  // Не ждем завершения - команда обрабатывается мгновенно
}

// Загрузка состояния из файла
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    
    // Загружаем состояние pump/dump ивента
    if (state.pumpDumpEvent && typeof state.pumpDumpEvent === 'object') {
      pumpDumpEvent = {
        isActive: state.pumpDumpEvent.isActive === true,
        finishResult: typeof state.pumpDumpEvent.finishResult === 'number' ? state.pumpDumpEvent.finishResult : 0,
        pumpThreshold: typeof state.pumpDumpEvent.pumpThreshold === 'number' ? state.pumpDumpEvent.pumpThreshold : null,
        dumpThreshold: typeof state.pumpDumpEvent.dumpThreshold === 'number' ? state.pumpDumpEvent.dumpThreshold : null,
        pinnedMessageId: typeof state.pumpDumpEvent.pinnedMessageId === 'number' ? state.pumpDumpEvent.pinnedMessageId : null,
        eventChatId: typeof state.pumpDumpEvent.eventChatId === 'number' ? state.pumpDumpEvent.eventChatId : null
      };
      console.log(`[LOAD_STATE] ✅ Pump/Dump event state loaded: active=${pumpDumpEvent.isActive}, finishResult=${pumpDumpEvent.finishResult}, pumpThreshold=${pumpDumpEvent.pumpThreshold}, dumpThreshold=${pumpDumpEvent.dumpThreshold}`);
      
      // Если ивент активен, сообщение уже должно быть закреплено
      // Не отправляем сообщение при загрузке состояния
      if (pumpDumpEvent.isActive && pumpDumpEvent.eventChatId) {
        console.log(`[LOAD_STATE] ℹ️ Event is active, message should already be pinned (${pumpDumpEvent.pinnedMessageId || 'not set'})`);
      }
    }

    // Загружаем инвентарь магазина
    userInventory = {};
    if (state.userInventory && typeof state.userInventory === 'object') {
      for (const [userId, items] of Object.entries(state.userInventory)) {
        const normalized = normalizeInventoryEntry(items);
        if (Object.keys(normalized).length > 0) {
          userInventory[userId] = normalized;
        }
      }
      const totalUsersWithInventory = Object.keys(userInventory).length;
      if (totalUsersWithInventory > 0) {
        console.log(`[LOAD_STATE] ✅ Loaded store inventory for ${totalUsersWithInventory} users`);
      }
    }
    
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[LOAD_STATE] ℹ️ No state file found, starting fresh`);
    } else {
      console.error(`[LOAD_STATE] ❌ Error loading state:`, error.message);
    }
    return false;
  }
}

// ==================== МАГАЗИН И ТОВАРЫ ====================
function buildShopMessage() {
  const lines = [
    '🛒 Магазин бустеров PUMP/DUMP',
    '',
    'Доступные товары:'
  ];

  for (const item of STORE_ITEM_LIST) {
    const dumpCommand = item.id.replace('pump', 'dump');
    const priceText = `${item.priceStars}⭐`;
    lines.push(
      `• ${item.title} — ${priceText}`,
      `   Одноразово сдвигает результат ивента на ±${item.delta} через команды ${item.id}/${dumpCommand}.`,
      ''
    );
  }

  lines.push('Покупки можно делать неограниченно. Бустер списывается при использовании команды. 85% доходов идут на выкуп $TONDEV');
  return lines.join('\n');
}

function buildInventoryMessage(userId) {
  const lines = [
    '🎒 Инвентарь бустеров',
    '',
    'Ваши бустеры:'
  ];

  let hasAnyItems = false;
  for (const item of STORE_ITEM_LIST) {
    const count = getInventoryCount(userId, item.id);
    if (count > 0) {
      hasAnyItems = true;
      const dumpCommand = item.id.replace('pump', 'dump');
      lines.push(
        `• ${item.title}: ${count} шт.`,
        `   Команды: ${item.id} / ${dumpCommand}`
      );
    }
  }

  if (!hasAnyItems) {
    lines.push('У вас пока нет бустеров.');
    lines.push('');
    lines.push('Купите бустеры в магазине!');
  }

  return lines.join('\n');
}

// Обработчик команды /start - всегда показывает магазин
bot.onText(/\/start(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  
  // Команда /start работает только в приватных чатах с ботом
  if (chatId <= 0) {
    return bot.sendPhoto(chatId, SHOP_IMAGE_URL, {
      caption: '🛒 Магазин доступен только в приватных сообщениях с ботом. Напишите боту в личку: @pumpordumprobot'
    });
  }
  
  // Всегда показываем магазин при команде /start
  const userId = msg.from?.id;
  const inline_keyboard = [];
  
  // Обычный режим - только оплата
  for (const item of STORE_ITEM_LIST) {
    inline_keyboard.push([
      { text: `${item.title} — ${item.priceStars}⭐`, callback_data: `buy:${item.id}` }
    ]);
  }
  
  inline_keyboard.push([{ text: '🎒 Инвентарь', callback_data: 'inventory:show' }]);

  await bot.sendPhoto(chatId, SHOP_IMAGE_URL, {
    caption: buildShopMessage(),
    reply_markup: { inline_keyboard }
  });
});

bot.onText(/\/shop$/i, async (msg) => {
  const chatId = msg.chat.id;
  
  // Команда /shop работает только в приватных чатах с ботом
  if (chatId <= 0) {
    return bot.sendPhoto(chatId, SHOP_IMAGE_URL, {
      caption: '🛒 Магазин доступен только в приватных сообщениях с ботом. Напишите боту в личку: @pumpordumprobot'
    });
  }
  
  const inline_keyboard = [];
  
  // Обычный режим - только оплата
  for (const item of STORE_ITEM_LIST) {
    inline_keyboard.push([
      { text: `${item.title} — ${item.priceStars}⭐`, callback_data: `buy:${item.id}` }
    ]);
  }
  
  inline_keyboard.push([{ text: '🎒 Инвентарь', callback_data: 'inventory:show' }]);

  await bot.sendPhoto(chatId, SHOP_IMAGE_URL, {
    caption: buildShopMessage(),
    reply_markup: { inline_keyboard }
  });
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id || userId;

  // Обработка показа инвентаря
  if (data === 'inventory:show') {
    if (!userId) {
      return bot.answerCallbackQuery(query.id, { text: 'Не удалось определить пользователя', show_alert: true });
    }

    const inventoryText = buildInventoryMessage(userId);
    
    // Создаем клавиатуру с кнопками покупки для каждого товара
    const inline_keyboard = [];
    
    if (FREE_SHOP_MODE) {
      // В тестовом режиме показываем две опции
      for (const item of STORE_ITEM_LIST) {
        const count = getInventoryCount(userId, item.id);
        const countText = count > 0 ? ` (${count} шт.)` : '';
        inline_keyboard.push([
          { text: `✅ ${item.title}${countText} — Получить бесплатно`, callback_data: `buy_free:${item.id}` }
        ]);
        inline_keyboard.push([
          { text: `💳 ${item.title} — Тест оплаты ${item.priceStars}⭐`, callback_data: `buy_pay:${item.id}` }
        ]);
      }
    } else {
      // Обычный режим
      for (const item of STORE_ITEM_LIST) {
        const count = getInventoryCount(userId, item.id);
        const buttonText = count > 0 
          ? `${item.title} — ${count} шт. | Купить ${item.priceStars}⭐` 
          : `${item.title} — ${item.priceStars}⭐`;
        inline_keyboard.push([{ text: buttonText, callback_data: `buy:${item.id}` }]);
      }
    }
    
    inline_keyboard.push([{ text: '🛒 Вернуться в магазин', callback_data: 'shop:show' }]);

    try {
      await bot.editMessageText(inventoryText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard }
      });
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      // Если не удалось отредактировать сообщение, отправляем новое
      await bot.sendMessage(chatId, inventoryText, {
        reply_markup: { inline_keyboard }
      });
      await bot.answerCallbackQuery(query.id);
    }
    return;
  }

  // Обработка возврата в магазин
  if (data === 'shop:show') {
    if (!userId) {
      return bot.answerCallbackQuery(query.id, { text: 'Не удалось определить пользователя', show_alert: true });
    }

    const shopText = buildShopMessage();
    const inline_keyboard = [];
    
    // В тестовом режиме показываем две опции: бесплатно и тест оплаты
    if (FREE_SHOP_MODE) {
      for (const item of STORE_ITEM_LIST) {
        inline_keyboard.push([
          { text: `✅ ${item.title} — Получить бесплатно`, callback_data: `buy_free:${item.id}` }
        ]);
        inline_keyboard.push([
          { text: `💳 ${item.title} — Тест оплаты ${item.priceStars}⭐`, callback_data: `buy_pay:${item.id}` }
        ]);
      }
    } else {
      // Обычный режим - только оплата
      for (const item of STORE_ITEM_LIST) {
        inline_keyboard.push([
          { text: `${item.title} — ${item.priceStars}⭐`, callback_data: `buy:${item.id}` }
        ]);
      }
    }
    
    inline_keyboard.push([{ text: '🎒 Инвентарь', callback_data: 'inventory:show' }]);

    try {
      await bot.editMessageText(shopText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard }
      });
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      await bot.sendMessage(chatId, shopText, {
        reply_markup: { inline_keyboard }
      });
      await bot.answerCallbackQuery(query.id);
    }
    return;
  }

  // Обработка покупки товара
  // Поддерживаем: buy:itemId (обычная покупка), buy_free:itemId (бесплатно), buy_pay:itemId (тест оплаты)
  let itemId;
  let purchaseType = 'normal'; // 'normal', 'free', 'pay'
  
  if (data.startsWith('buy_free:')) {
    purchaseType = 'free';
    itemId = data.split(':')[1];
  } else if (data.startsWith('buy_pay:')) {
    purchaseType = 'pay';
    itemId = data.split(':')[1];
  } else if (data.startsWith('buy:')) {
    purchaseType = 'normal';
    itemId = data.split(':')[1];
  } else {
    return; // Не наш callback
  }

  const item = STORE_ITEMS[itemId];

  if (!item) {
    return bot.answerCallbackQuery(query.id, { text: 'Товар не найден', show_alert: true });
  }

  // Бесплатное получение (buy_free или FREE_SHOP_MODE с обычной покупкой)
  if (purchaseType === 'free' || (FREE_SHOP_MODE && purchaseType === 'normal')) {
    if (!userId) {
      return bot.answerCallbackQuery(query.id, { text: 'Не удалось определить пользователя', show_alert: true });
    }

    // Выдаем товар бесплатно
    addInventoryItem(userId, item.id, 1);
    const dumpCommand = item.id.replace('pump', 'dump');
    const total = getInventoryCount(userId, item.id);

    await bot.answerCallbackQuery(query.id, { text: `✅ ${item.title} добавлен в инвентарь!`, show_alert: false });
    
    // Определяем, из какого сообщения пришла покупка (магазин или инвентарь)
    const messageText = query.message?.text || '';
    const isFromInventory = messageText.includes('Инвентарь');

    // Обновляем сообщение в зависимости от того, откуда пришла покупка
    if (isFromInventory) {
      const inventoryText = buildInventoryMessage(userId);
      const inline_keyboard = [];
      
      // Обычный режим: только покупка за Stars
      for (const storeItem of STORE_ITEM_LIST) {
        const count = getInventoryCount(userId, storeItem.id);
        const buttonText = count > 0 
          ? `${storeItem.title} — ${count} шт. | Купить ${storeItem.priceStars}⭐` 
          : `${storeItem.title} — ${storeItem.priceStars}⭐`;
        inline_keyboard.push([{ text: buttonText, callback_data: `buy:${storeItem.id}` }]);
      }
      
      inline_keyboard.push([{ text: '🛒 Вернуться в магазин', callback_data: 'shop:show' }]);

      try {
        await bot.editMessageText(inventoryText, {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard }
        });
      } catch (error) {
        // Если не удалось обновить, отправляем новое сообщение
        await bot.sendMessage(userId, inventoryText, {
          reply_markup: { inline_keyboard }
        });
      }
    } else {
      // Обновляем магазин
      const shopText = buildShopMessage();
      const inline_keyboard = [];
      
      // Обычный режим - только оплата
      for (const storeItem of STORE_ITEM_LIST) {
        inline_keyboard.push([
          { text: `${storeItem.title} — ${storeItem.priceStars}⭐`, callback_data: `buy:${storeItem.id}` }
        ]);
      }
      
      inline_keyboard.push([{ text: '🎒 Инвентарь', callback_data: 'inventory:show' }]);

      try {
        await bot.editMessageText(shopText, {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard }
        });
      } catch (error) {
        // Если не удалось обновить, отправляем новое сообщение
        await bot.sendMessage(userId, shopText, {
          reply_markup: { inline_keyboard }
        });
      }
    }

    console.log(`[SHOP] ✅ Free item granted: ${item.title} to user ${userId}`);
    return;
  }

  // Оплата Stars (обычный режим или тест оплаты в тестовом режиме)
  // Для цифровых товаров provider_token не требуется (можно использовать пустую строку)
  // Согласно документации: https://core.telegram.org/bots/payments-stars
  if (!userId) {
    return bot.answerCallbackQuery(query.id, { text: 'Не удалось определить пользователя', show_alert: true });
  }

  const payload = JSON.stringify({ type: 'store_purchase', itemId: item.id });

  try {
    // Отправляем инвойс в приватный чат пользователя, а не в групповой чат
    // provider_token пустой для цифровых товаров (не требуется по документации Telegram)
    // prices должен быть массивом объектов с полями label (string) и amount (number)
    const prices = [{
      label: String(item.title), // Явно преобразуем в строку
      amount: parseInt(String(item.priceStars), 10) // Явно преобразуем в целое число
    }];
    
    // startParameter должен быть уникальной строкой для каждого инвойса
    const startParameter = `buy_${item.id}_${Date.now()}`;
    
    console.log(`[SHOP] Sending invoice: userId=${userId}, title=${item.title}, prices=`, JSON.stringify(prices));
    
    // Используем прямой HTTP вызов к Telegram Bot API для обхода возможных проблем с библиотекой
    const invoiceData = {
      chat_id: userId,
      title: String(item.title),
      description: String(item.description),
      payload: payload,
      provider_token: '', // Пустая строка для цифровых товаров
      start_parameter: startParameter,
      currency: 'XTR',
      prices: prices,
      reply_markup: {
        inline_keyboard: [[{ text: `Оплатить ${item.priceStars}⭐`, pay: true }]]
      }
    };
    
    console.log(`[SHOP] Invoice data:`, JSON.stringify(invoiceData, null, 2));
    
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendInvoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(invoiceData)
    });
    
    const result = await response.json();
    
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description || JSON.stringify(result)}`);
    }
    
    console.log(`[SHOP] ✅ Invoice sent successfully via direct API call`);

    await bot.answerCallbackQuery(query.id, { text: 'Счет отправлен в личные сообщения', show_alert: false });
  } catch (error) {
    console.error(`[SHOP] ❌ Error sending invoice:`, error.message);
    await bot.answerCallbackQuery(query.id, { text: `Не удалось отправить счет: ${error.message}`, show_alert: true });
  }
});

bot.on('pre_checkout_query', async (checkout) => {
  try {
    await bot.answerPreCheckoutQuery(checkout.id, true);
  } catch (error) {
    console.error(`[SHOP] ❌ Error in pre_checkout_query:`, error.message);
  }
});

bot.on('message', async (msg) => {
  if (!msg.successful_payment) return;

  const payment = msg.successful_payment;
  const payloadRaw = payment.invoice_payload;
  let payload;

  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    return;
  }

  if (!payload || payload.type !== 'store_purchase') {
    return;
  }

  const item = STORE_ITEMS[payload.itemId];
  const userId = msg.from?.id;

  if (!item || !userId) return;

  addInventoryItem(userId, item.id, 1);
  const dumpCommand = item.id.replace('pump', 'dump');
  const total = getInventoryCount(userId, item.id);

  // Отправляем сообщение в приватный чат пользователя, а не в групповой чат
  await bot.sendMessage(
    userId,
    `✅ Оплата ${item.title} за ${item.priceStars}⭐ подтверждена.\n` +
    `Доступно в инвентаре: ${total} шт.\n` +
    `Используйте команды ${item.id} или ${dumpCommand}, чтобы сдвинуть результат на ${item.delta}.`
  ).catch(() => {});
});

// ==================== PUMP/DUMP EVENT FUNCTIONS ====================
// Функция для отправки/обновления сообщения об ивенте
// Отправляет сообщение только при старте ивента (если нет закрепленного сообщения)
// Обновляет существующее закрепленное сообщение при командах /pump и /dump
async function updateEventMessage(chatId) {
  if (!pumpDumpEvent.isActive) {
    return;
  }
  
  // Защита от множественных одновременных вызовов
  // Проверяем и устанавливаем флаг атомарно, чтобы предотвратить race condition
  if (isUpdatingEventMessage) {
    console.log(`[EVENT_MESSAGE] ⚠️ Message update already in progress, skipping duplicate call`);
    return;
  }
  
  // Устанавливаем флаг СРАЗУ, до любых асинхронных операций
  // Только если нет закрепленного сообщения (при старте ивента)
  if (!pumpDumpEvent.pinnedMessageId) {
    isUpdatingEventMessage = true;
  } else {
    // При обновлении существующего сообщения тоже устанавливаем флаг для защиты от race condition
    isUpdatingEventMessage = true;
  }
  
  try {
    // Получаем актуальный баланс для отображения
    const { tonBalance, tondevBalance } = await calculateDynamicThresholds(true);
    
    const shopLink = 'https://t.me/pumpordumprobot?start=shop';
    const messageText = `🎯 Ивент запущен! Текущий результат: ${pumpDumpEvent.finishResult > 0 ? '+' : ''}${pumpDumpEvent.finishResult}\n\nИспользуйте /pump (+1) или /dump (-1) для изменения результата.\n\n🛒 <a href="${shopLink}">Магазин бустеров</a> — усильте влияние на результат!\n\n💰 Текущий баланс кошелька:\n• TON: ${tonBalance.toFixed(4)}\n• TONDEV: ${tondevBalance.toFixed(4)}\n\n📊 Динамические пороги (зафиксированы при старте):\n• Pump: +${pumpDumpEvent.pumpThreshold} (для покупки)\n• Dump: -${pumpDumpEvent.dumpThreshold} (для продажи)\n\n💡 Пороги рассчитываются автоматически на основе соотношения TONDEV и TON на балансе кошелька и фиксируются при старте ивента.`;
    
    // Если есть закрепленное сообщение, обновляем его (при командах /pump и /dump)
    if (pumpDumpEvent.pinnedMessageId) {
      try {
        await bot.editMessageText(messageText, {
          chat_id: chatId,
          message_id: pumpDumpEvent.pinnedMessageId,
          parse_mode: 'HTML'
        });
        console.log(`[EVENT_MESSAGE] ✅ Updated pinned message ${pumpDumpEvent.pinnedMessageId}`);
        isUpdatingEventMessage = false; // Сбрасываем флаг после успешного обновления
        return;
      } catch (editError) {
        const errorMsg = editError.message || String(editError);
        // Если сообщение не изменилось - это нормально, просто игнорируем
        if (errorMsg.includes('message is not modified') || errorMsg.includes('not modified')) {
          console.log(`[EVENT_MESSAGE] ℹ️ Message content unchanged, skipping update`);
          isUpdatingEventMessage = false;
          return;
        }
        // Если сообщение удалено или недоступно, отправляем новое
        if (errorMsg.includes('message to edit not found') || errorMsg.includes('not found') || errorMsg.includes('bad request')) {
          console.log(`[EVENT_MESSAGE] ⚠️ Could not edit message (deleted or inaccessible), sending new one:`, errorMsg);
          pumpDumpEvent.pinnedMessageId = null;
        } else {
          // Для других ошибок просто логируем и не отправляем новое сообщение
          console.log(`[EVENT_MESSAGE] ⚠️ Error editing message:`, errorMsg);
          isUpdatingEventMessage = false;
          return;
        }
      }
    }
    
    // Дополнительная проверка: если pinnedMessageId уже установлен (другой запрос успел отправить), не отправляем повторно
    if (pumpDumpEvent.pinnedMessageId) {
      console.log(`[EVENT_MESSAGE] ⚠️ Message already pinned (${pumpDumpEvent.pinnedMessageId}), skipping duplicate send`);
      isUpdatingEventMessage = false;
      return;
    }
    
    // Отправляем новое сообщение и закрепляем его (если не было закрепленного сообщения)
    const sentMessage = await bot.sendMessage(chatId, messageText, { parse_mode: 'HTML' });
    
    // Еще раз проверяем, что pinnedMessageId не установлен (race condition protection)
    // Если установлен, значит другой запрос успел отправить и закрепить сообщение
    if (pumpDumpEvent.pinnedMessageId && pumpDumpEvent.pinnedMessageId !== sentMessage.message_id) {
      console.log(`[EVENT_MESSAGE] ⚠️ Message was pinned by another request (${pumpDumpEvent.pinnedMessageId}) while sending, deleting duplicate`);
      // Удаляем дубликат сообщения, которое мы только что отправили
      try {
        await bot.deleteMessage(chatId, sentMessage.message_id);
      } catch (deleteError) {
        // Игнорируем ошибку удаления
      }
      isUpdatingEventMessage = false;
      return;
    }
    
    // Устанавливаем pinnedMessageId только если он еще не установлен
    if (!pumpDumpEvent.pinnedMessageId) {
      pumpDumpEvent.pinnedMessageId = sentMessage.message_id;
      pumpDumpEvent.eventChatId = chatId;
    }
    
    // Закрепляем сообщение
    try {
      await bot.pinChatMessage(chatId, sentMessage.message_id, { disable_notification: true });
      console.log(`[EVENT_MESSAGE] ✅ Sent and pinned message ${sentMessage.message_id}`);
    } catch (pinError) {
      console.error(`[EVENT_MESSAGE] ⚠️ Could not pin message:`, pinError.message);
      // Продолжаем работу даже если не удалось закрепить
    }
    
    saveState(); // Сохраняем messageId
    isUpdatingEventMessage = false; // Снимаем флаг только после успешной отправки
  } catch (error) {
    const errorMsg = error.message || String(error);
    console.error(`[EVENT_MESSAGE] ❌ Error updating event message:`, errorMsg);
    
    // Если это ошибка 429 (Too Many Requests), сбрасываем флаг через некоторое время
    // чтобы позволить повторную попытку после rate limit
    if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
      const retryAfter = error.response?.parameters?.retry_after || 5;
      console.log(`[EVENT_MESSAGE] ⏳ Rate limit hit, will reset flag after ${retryAfter} seconds`);
      setTimeout(() => {
        // Сбрасываем флаг только если сообщение все еще не закреплено
        if (!pumpDumpEvent.pinnedMessageId) {
          isUpdatingEventMessage = false;
          console.log(`[EVENT_MESSAGE] ✅ Reset flag after rate limit`);
        }
      }, (retryAfter + 1) * 1000);
    } else {
      // Для других ошибок НЕ сбрасываем флаг сразу, чтобы предотвратить повторные попытки
      // Но сбрасываем через 10 секунд на случай, если это была временная ошибка
      setTimeout(() => {
        if (!pumpDumpEvent.pinnedMessageId) {
          isUpdatingEventMessage = false;
          console.log(`[EVENT_MESSAGE] ✅ Reset flag after error timeout`);
        }
      }, 10000);
    }
  }
}

// Функция для отправки и закрепления сообщения при старте ивента
function sendInitialEventMessage(chatId) {
  // Отправляем сообщение только если еще не обновляется и нет закрепленного сообщения
  if (!isUpdatingEventMessage && !pumpDumpEvent.pinnedMessageId) {
    updateEventMessage(chatId).catch(err => {
      console.error(`[EVENT_MESSAGE] ❌ Error sending initial event message:`, err.message);
    });
  } else if (pumpDumpEvent.pinnedMessageId) {
    console.log(`[EVENT_MESSAGE] ℹ️ Message already pinned (${pumpDumpEvent.pinnedMessageId}), skipping initial send`);
  }
}


async function checkEventCompletion(chatId) {
  // Проверяем, активен ли ивент (мог быть завершен другим вызовом)
  if (!pumpDumpEvent.isActive) {
    console.log(`[CHECK_EVENT] ⚠️ Event is not active, skipping check`);
    return;
  }
  
  // Защита от множественных одновременных проверок завершения
  if (eventLock || isProcessingTransaction) {
    console.log(`[CHECK_EVENT] ⚠️ Event lock or transaction processing is active, skipping check`);
    return;
  }
  
  eventLock = true;
  try {
    // Повторная проверка после получения блокировки (на случай если ивент был завершен)
    if (!pumpDumpEvent.isActive) {
      console.log(`[CHECK_EVENT] ⚠️ Event was completed by another process, skipping check`);
      return;
    }
    
    console.log(`[CHECK_EVENT] 🔍 Checking completion: finishResult=${pumpDumpEvent.finishResult}`);
    
    // Используем сохраненные пороги (фиксированные при старте ивента)
    // Если пороги не сохранены (старый формат), рассчитываем их один раз
    let pumpThreshold = pumpDumpEvent.pumpThreshold;
    let dumpThreshold = pumpDumpEvent.dumpThreshold;
    
    if (pumpThreshold === null || dumpThreshold === null) {
      console.log(`[CHECK_EVENT] ⚠️ Thresholds not saved, calculating once...`);
      const calculated = await calculateDynamicThresholds(false);
      pumpThreshold = calculated.pumpThreshold;
      dumpThreshold = calculated.dumpThreshold;
      // Сохраняем пороги для будущих проверок
      pumpDumpEvent.pumpThreshold = pumpThreshold;
      pumpDumpEvent.dumpThreshold = dumpThreshold;
      saveState();
    }
    
    console.log(`[CHECK_EVENT] 📊 Thresholds: pumpThreshold=${pumpThreshold}, dumpThreshold=${dumpThreshold}, finishResult=${pumpDumpEvent.finishResult}`);
  
    if (pumpDumpEvent.finishResult >= pumpThreshold) {
      // Ивент завершен с PUMP
      // Проверяем еще раз, что ивент активен (защита от race condition)
      if (!pumpDumpEvent.isActive) {
        console.log(`[CHECK_EVENT] ⚠️ Event was already completed, skipping PUMP transaction`);
        return;
      }
      
      // Устанавливаем флаг обработки транзакции ДО изменения состояния
      isProcessingTransaction = true;
      
      const finalResult = pumpDumpEvent.finishResult;
      pumpDumpEvent.isActive = false;
      pumpDumpEvent.finishResult = 0; // Сбрасываем результат после завершения
      saveState(); // Немедленное сохранение (неблокирующее)
      
      console.log(`[PUMP/DUMP] ✅ Event completed with PUMP (finalResult=${finalResult}, threshold=${pumpThreshold})`);
      
      // Снимаем eventLock перед отправкой сообщения и транзакции
      eventLock = false;
      
      const message = Array(10).fill('❗️LEEEET\'S PUMP TONDEV❗️').join('\n');
      await bot.sendMessage(chatId, message);
      
      // Проверяем, не заблокированы ли транзакции
      if (DISABLE_TRANSACTIONS) {
        console.log(`[PUMP/DUMP] 🚫 Transactions disabled - skipping TONDEV purchase`);
        await bot.sendMessage(chatId, `⚠️ Транзакции заблокированы (тестовый режим). Покупка TONDEV не выполнена.`);
        isProcessingTransaction = false;
      } else {
        // Автоматическая покупка TONDEV (асинхронно, не блокируем)
        console.log(`[PUMP/DUMP] 🚀 Triggering automatic TONDEV purchase...`);
        buyTondev(chatId).catch(err => {
          console.error(`[PUMP/DUMP] Error in buyTondev:`, err.message);
        }).finally(() => {
          // Снимаем флаг после завершения транзакции (успешной или с ошибкой)
          isProcessingTransaction = false;
        });
      }
      
      return; // Выходим, чтобы не снимать eventLock дважды
    } else if (pumpDumpEvent.finishResult <= -dumpThreshold) {
      // Ивент завершен с DUMP
      // Проверяем еще раз, что ивент активен (защита от race condition)
      if (!pumpDumpEvent.isActive) {
        console.log(`[CHECK_EVENT] ⚠️ Event was already completed, skipping DUMP transaction`);
        return;
      }
      
      // Устанавливаем флаг обработки транзакции ДО изменения состояния
      isProcessingTransaction = true;
      
      const finalResult = pumpDumpEvent.finishResult;
      pumpDumpEvent.isActive = false;
      pumpDumpEvent.finishResult = 0; // Сбрасываем результат после завершения
      saveState(); // Немедленное сохранение (неблокирующее)
      
      console.log(`[PUMP/DUMP] ✅ Event completed with DUMP (finalResult=${finalResult}, threshold=${dumpThreshold})`);
      
      // Снимаем eventLock перед отправкой сообщения и транзакции
      eventLock = false;
      
      const message = Array(10).fill('❗️LEEEET\'S DUMP TONDEV❗️').join('\n');
      await bot.sendMessage(chatId, message);
      
      // Проверяем, не заблокированы ли транзакции
      if (DISABLE_TRANSACTIONS) {
        console.log(`[PUMP/DUMP] 🚫 Transactions disabled - skipping TONDEV sale`);
        await bot.sendMessage(chatId, `⚠️ Транзакции заблокированы (тестовый режим). Продажа TONDEV не выполнена.`);
        isProcessingTransaction = false;
      } else {
        // Автоматическая продажа всех TONDEV токенов (асинхронно, не блокируем)
        console.log(`[PUMP/DUMP] 🚀 Triggering automatic TONDEV sale...`);
        sellTondev(chatId).catch(err => {
          console.error(`[PUMP/DUMP] Error in sellTondev:`, err.message);
        }).finally(() => {
          // Снимаем флаг после завершения транзакции (успешной или с ошибкой)
          isProcessingTransaction = false;
        });
      }
      
      return; // Выходим, чтобы не снимать eventLock дважды
    } else {
      console.log(`[CHECK_EVENT] ⚠️ Event continues: finishResult=${pumpDumpEvent.finishResult}, pumpThreshold=${pumpThreshold}, dumpThreshold=${dumpThreshold}`);
    }
  } finally {
    // Снимаем блокировку только если она еще установлена (не была снята при завершении ивента)
    if (eventLock) {
      eventLock = false;
    }
  }
}

// ==================== КОМАНДА /PUMPORDUMP ====================
// Поддерживает параметры: /pumpOrDump, /pumpOrDump pump20, /pumpOrDump dump-20
bot.onText(/\/pumpOrDump(?:\s+(pump|dump)(-?\d+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Парсим параметры команды
    const type = match?.[1]?.toLowerCase(); // 'pump' или 'dump'
    const value = match?.[2] ? parseInt(match[2], 10) : null; // число или null

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        console.log(`[/PUMPORDUMP] ❌ Access denied: chat ${chatId} is not allowed (allowed: ${ALLOWED_PUMP_DUMP_CHAT_ID})`);
        return; // Просто игнорируем команду
    }

    // Проверяем, что команда отправлена администратором
    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    // Защита от одновременных запусков ивента
    if (eventLock || isUpdatingEventMessage) {
        console.log(`[/PUMPORDUMP] ⚠️ Event is being started by another request, skipping duplicate`);
        return bot.sendMessage(chatId, `⏳ Ивент уже запускается, подождите секунду...`).catch(() => {});
    }

    // Проверяем, не запущен ли уже ивент
    if (pumpDumpEvent.isActive) {
        return bot.sendMessage(chatId, `⚠️ Ивент уже активен! Текущий результат: ${pumpDumpEvent.finishResult > 0 ? '+' : ''}${pumpDumpEvent.finishResult}`);
    }

    // Устанавливаем блокировку перед запуском ивента
    eventLock = true;
    
    // Отправляем ответ пользователю сразу, чтобы он знал, что команда обрабатывается
    bot.sendMessage(chatId, `🔄 Запускаю ивент... Проверяю баланс кошелька...`).catch(() => {});
    
    try {
        // Рассчитываем динамические пороги ПЕРЕД запуском ивента (без кэша) с таймаутом
        const calculatePromise = calculateDynamicThresholds(false);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout: проверка баланса заняла слишком много времени')), 15000)
        );
        
        const { pumpThreshold, dumpThreshold, tonBalance, tondevBalance } = await Promise.race([
            calculatePromise,
            timeoutPromise
        ]);
        
        // Определяем начальное значение finishResult
        let initialFinishResult = 0;
        if (type && value !== null) {
            if (type === 'pump') {
                initialFinishResult = value;
            } else if (type === 'dump') {
                // Если указано dump20 (без минуса), делаем отрицательным
                // Если указано dump-20 (с минусом), value уже отрицательное
                initialFinishResult = value < 0 ? value : -value;
            }
        }
        
        // Валидация: проверяем, что начальное значение не равно или не превышает порог завершения
        if (type === 'pump' && initialFinishResult >= pumpThreshold) {
            eventLock = false;
            return bot.sendMessage(chatId, `❌ Нельзя стартовать ивент со значением ${initialFinishResult}, так как оно равно или превышает порог завершения pump (${pumpThreshold}). Начальное значение должно быть меньше ${pumpThreshold}.`);
        }
        
        if (type === 'dump' && initialFinishResult <= -dumpThreshold) {
            eventLock = false;
            return bot.sendMessage(chatId, `❌ Нельзя стартовать ивент со значением ${initialFinishResult}, так как оно равно или превышает порог завершения dump (${-dumpThreshold}). Начальное значение должно быть больше ${-dumpThreshold}.`);
        }
        
        // Еще раз проверяем, не запущен ли ивент (на случай если другой запрос успел запустить)
        if (pumpDumpEvent.isActive) {
            eventLock = false;
            return bot.sendMessage(chatId, `⚠️ Ивент уже активен! Текущий результат: ${pumpDumpEvent.finishResult > 0 ? '+' : ''}${pumpDumpEvent.finishResult}`);
        }
        
        // Запускаем новый ивент с фиксированными порогами
        pumpDumpEvent.isActive = true;
        pumpDumpEvent.finishResult = initialFinishResult;
        pumpDumpEvent.pumpThreshold = pumpThreshold; // Фиксируем пороги при старте
        pumpDumpEvent.dumpThreshold = dumpThreshold; // Фиксируем пороги при старте
        pumpDumpEvent.eventChatId = chatId; // Сохраняем ID чата
        pumpDumpEvent.pinnedMessageId = null; // Сбрасываем закрепленное сообщение
        saveState(); // Немедленное сохранение (неблокирующее)
        
        const startMsg = initialFinishResult !== 0 
            ? `✅ Event started by user ${userId} in chat ${chatId} with initial value: ${initialFinishResult > 0 ? '+' : ''}${initialFinishResult}, thresholds: pump=${pumpThreshold}, dump=${dumpThreshold}`
            : `✅ Event started by user ${userId} in chat ${chatId} with thresholds: pump=${pumpThreshold}, dump=${dumpThreshold}`;
        console.log(`[/PUMPORDUMP] ${startMsg}`);
        
        // Снимаем eventLock перед отправкой сообщения (updateEventMessage сам управляет isUpdatingEventMessage)
        eventLock = false;
        
        // Отправляем и закрепляем сообщение при старте ивента
        sendInitialEventMessage(chatId);
        
        // Проверяем, не достигнут ли порог сразу после старта с начальным значением
        if (initialFinishResult !== 0) {
            checkEventCompletion(chatId).catch(err => {
                console.error(`[/PUMPORDUMP] ❌ Error in checkEventCompletion:`, err.message);
            });
        }
    } catch (error) {
        // При ошибке сбрасываем блокировки
        eventLock = false;
        isUpdatingEventMessage = false;
        console.error(`[/PUMPORDUMP] ❌ Error starting event:`, error.message);
        
        // Отправляем сообщение об ошибке
        const errorMsg = error.message || 'Неизвестная ошибка';
        bot.sendMessage(chatId, `❌ Ошибка при запуске ивента: ${errorMsg.includes('Timeout') ? 'Проверка баланса заняла слишком много времени' : 'Попробуйте еще раз через несколько секунд'}`).catch(() => {});
        
        // Если ивент был частично запущен, откатываем изменения
        if (pumpDumpEvent.isActive) {
            pumpDumpEvent.isActive = false;
            pumpDumpEvent.finishResult = 0;
            pumpDumpEvent.pumpThreshold = null;
            pumpDumpEvent.dumpThreshold = null;
            pumpDumpEvent.pinnedMessageId = null;
            pumpDumpEvent.eventChatId = null;
            saveState();
        }
    }
});

// ==================== КОМАНДА /STOPEVENT ====================
bot.onText(/\/stopEvent$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    
    console.log(`[/STOPEVENT] 🔔 Command received from user ${userId} in chat ${chatId}`);

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        console.log(`[/STOPEVENT] ❌ Access denied: chat ${chatId} is not allowed (allowed: ${ALLOWED_PUMP_DUMP_CHAT_ID})`);
        return;
    }

    // Проверяем, что команда отправлена администратором
    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    // Проверяем, запущен ли ивент
    if (!pumpDumpEvent.isActive) {
        return bot.sendMessage(chatId, `ℹ️ Ивент не активен. Нет активных ивентов для остановки.`);
    }

    // Останавливаем ивент
    const finalResult = pumpDumpEvent.finishResult;
    pumpDumpEvent.isActive = false;
    pumpDumpEvent.finishResult = 0;
    pumpDumpEvent.pumpThreshold = null;
    pumpDumpEvent.dumpThreshold = null;
    pumpDumpEvent.pinnedMessageId = null;
    pumpDumpEvent.eventChatId = null;
    saveState();
    
    console.log(`[/STOPEVENT] ✅ Event stopped by user ${userId} in chat ${chatId}. Final result was: ${finalResult}`);
    
    bot.sendMessage(chatId, `🛑 Ивент остановлен администратором.\n\nФинальный результат: ${finalResult > 0 ? '+' : ''}${finalResult}`).catch(() => {});
});

// ==================== КОМАНДЫ БУСТЕРОВ ИЗ МАГАЗИНА ====================
async function handleInventoryCommand(msg, itemId, delta) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const item = STORE_ITEMS[itemId];

    if (!item) {
        return;
    }

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        return; // Просто игнорируем команду
    }

    if (!userId) {
        return bot.sendMessage(chatId, 'Не удалось определить пользователя для списания бустера.');
    }

    // Проверяем, является ли пользователь админом (кроме ID 367102417)
    if (userId && userId !== 367102417) {
        const userIsAdmin = await isAdmin(chatId, userId);
        if (userIsAdmin) {
            return bot.sendMessage(chatId, 'Админы не могут участовать в PUMP или DUMP $TONDEV. Снимите с себя админку и попробуйте позже');
        }
    }

    if (!pumpDumpEvent.isActive) {
        return bot.sendMessage(chatId, 'На данный момент нет активного ивента. Попроси админа запустить /pumpOrDump, чтобы использовать бустер.');
    }

    // Защита от спама: персональная блокировка для пользователя
    if (userLocks[userId]) {
        bot.sendMessage(chatId, `⏳ Ваша предыдущая команда еще обрабатывается, подождите...`).catch(() => {});
        return;
    }

    // Защита от race conditions с retry механизмом
    let retryCount = 0;
    const maxRetries = 10; // До 10 попыток (1 секунда максимум)
    const retryDelay = 100; // 100ms между попытками

    while (eventLock && retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryCount++;
    }

    if (eventLock) {
        bot.sendMessage(chatId, `⏳ Команда обрабатывается, попробуйте через секунду...`).catch(() => {});
        return; // Игнорируем команду если идет обработка
    }

    // Устанавливаем блокировки
    eventLock = true;
    userLocks[userId] = true;
    
    let currentResult = pumpDumpEvent.finishResult;
    let actualDelta = delta; // Реальное изменение (может быть уменьшено если нет бустеров)
    let usedBooster = false;
    
    try {
        // Проверяем, что ивент еще активен (мог быть завершен другим процессом)
        if (!pumpDumpEvent.isActive) {
            console.log(`[BOOSTER] ⚠️ Event is not active, ignoring command`);
            eventLock = false;
            delete userLocks[userId];
            return;
        }

        // Проверяем количество бустеров ВНУТРИ блокировки (защита от спама)
        const boosterCount = getInventoryCount(userId, itemId);
        
        if (boosterCount > 0) {
            // Есть бустеры - списываем и применяем полный дельту
            const consumed = consumeInventoryItem(userId, itemId);
            if (consumed) {
                usedBooster = true;
                actualDelta = delta; // Применяем полный дельту бустера
                console.log(`[BOOSTER] ✅ Booster ${item.title} consumed by user ${userId}, applying ${delta > 0 ? '+' : ''}${delta}`);
            } else {
                // Не удалось списать (редкий случай)
                actualDelta = 1; // Применяем только +1
                console.log(`[BOOSTER] ⚠️ Failed to consume booster, applying +1 instead`);
            }
        } else {
            // Нет бустеров - применяем только +1 вместо полного дельты бустера
            actualDelta = delta > 0 ? 1 : -1; // +1 или -1 вместо полного дельты
            console.log(`[BOOSTER] ⚠️ No boosters available for user ${userId}, applying ${actualDelta > 0 ? '+' : ''}${actualDelta} instead of ${delta > 0 ? '+' : ''}${delta}`);
        }

        // Применяем изменение
        pumpDumpEvent.finishResult += actualDelta;
        currentResult = pumpDumpEvent.finishResult;
        saveState(); // Асинхронное сохранение без await

        console.log(`[BOOSTER] ✅ ${actualDelta > 0 ? '+' : ''}${actualDelta} to finishResult by user ${userId}, new value: ${currentResult}`);
    } catch (err) {
        console.error(`[BOOSTER] ❌ Unexpected error:`, err.message);
        throw err;
    } finally {
        eventLock = false;
        // Снимаем персональную блокировку пользователя
        delete userLocks[userId];
    }

    // Проверяем, не достигнут ли порог (используем кэш порогов)
    if (pumpDumpEvent.isActive && !isProcessingTransaction) {
        checkEventCompletion(chatId).catch(err => {
            console.error(`[BOOSTER] ❌ Error in checkEventCompletion:`, err.message);
        });
    }

    // Обновляем закрепленное сообщение
    if (pumpDumpEvent.isActive) {
        updateEventMessage(chatId).catch(err => {
            console.error(`[BOOSTER] Error updating event message:`, err.message);
        });
    }

    const remaining = getInventoryCount(userId, itemId);
    const actualDeltaText = `${actualDelta > 0 ? '+' : ''}${actualDelta}`;
    const newResultText = currentResult > 0 ? `+${currentResult}` : `${currentResult}`;
    
    let messageText;
    if (usedBooster) {
        // Бустер был использован
        messageText = `🔥 Бустер ${item.title} применён (${actualDeltaText}). Текущий результат: ${newResultText}. Осталось бустеров: ${remaining}.`;
    } else {
        // Бустеров не было, применен только +1/-1
        const expectedDeltaText = `${delta > 0 ? '+' : ''}${delta}`;
        messageText = `⚠️ У тебя нет бустера ${item.title}. Применено только ${actualDeltaText} вместо ${expectedDeltaText}. Текущий результат: ${newResultText}.\n\nКупи бустеры в магазине: /shop`;
    }
    
    bot.sendMessage(chatId, messageText).catch(err => {
        console.error(`[BOOSTER] Error sending message:`, err.message);
    });
}

const INVENTORY_COMMANDS = [
    { regex: /^\/?pump10$/i, itemId: 'pump10', delta: 10 },
    { regex: /^\/?dump10$/i, itemId: 'pump10', delta: -10 },
    { regex: /^\/?pump25$/i, itemId: 'pump25', delta: 25 },
    { regex: /^\/?dump25$/i, itemId: 'pump25', delta: -25 },
    { regex: /^\/?pump50$/i, itemId: 'pump50', delta: 50 },
    { regex: /^\/?dump50$/i, itemId: 'pump50', delta: -50 },
];

INVENTORY_COMMANDS.forEach(({ regex, itemId, delta }) => {
    bot.onText(regex, (msg) => handleInventoryCommand(msg, itemId, delta));
});

// ==================== КОМАНДА /PUMP ====================
bot.onText(/^\/pump(?:\s|$)/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    
    console.log(`[/PUMP] 🔔 Command received from user ${userId} in chat ${chatId}`);

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        console.log(`[/PUMP] ❌ Access denied: chat ${chatId} is not allowed (allowed: ${ALLOWED_PUMP_DUMP_CHAT_ID})`);
        return; // Просто игнорируем команду
    }

    // Проверяем, является ли пользователь админом (кроме ID 367102417)
    if (userId && userId !== 367102417) {
        const userIsAdmin = await isAdmin(chatId, userId);
        if (userIsAdmin) {
            console.log(`[/PUMP] ❌ Admin ${userId} tried to use /pump command`);
            return bot.sendMessage(chatId, 'Админы не могут участовать в PUMP или DUMP $TONDEV. Снимите с себя админку и попробуйте позже');
        }
    }

    // Проверяем, запущен ли ивент
    if (!pumpDumpEvent.isActive) {
        return bot.sendMessage(chatId, 'На данный момент нет актуальных ивентов по дампу или пампу TONDEV. Обратись к админам чата, чтобы они запустили ивент');
    }

    // Защита от race conditions с retry механизмом
    let retryCount = 0;
    const maxRetries = 10; // До 10 попыток (1 секунда максимум)
    const retryDelay = 100; // 100ms между попытками
    
    while (eventLock && retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryCount++;
    }
    
    if (eventLock) {
        // Если после всех попыток блокировка все еще активна, отправляем ответ
        bot.sendMessage(chatId, `⏳ Команда обрабатывается, попробуйте через секунду...`).catch(() => {});
        return; // Игнорируем команду если идет обработка
    }
    
    eventLock = true;
    try {
        // Проверяем, что ивент еще активен (мог быть завершен другим процессом)
        if (!pumpDumpEvent.isActive) {
            console.log(`[/PUMP] ⚠️ Event is not active, ignoring command`);
            return;
        }
        
        // Увеличиваем finishResult на 1
        pumpDumpEvent.finishResult += 1;
        const currentResult = pumpDumpEvent.finishResult;
        saveState(); // Асинхронное сохранение без await
        
        console.log(`[/PUMP] ✅ +1 to finishResult, new value: ${currentResult}`);
        
        // Снимаем блокировку перед проверкой завершения
        eventLock = false;
        
        // Проверяем, не достигнут ли порог (используем кэш порогов)
        // Проверяем isActive еще раз после снятия блокировки
        if (pumpDumpEvent.isActive && !isProcessingTransaction) {
            // Вызываем проверку - она сама установит блокировку если нужно
            checkEventCompletion(chatId).catch(err => {
                // Логируем ошибку без деталей, чтобы не выдать чувствительную информацию
                console.error(`[/PUMP] ❌ Error in checkEventCompletion:`, err.message);
                // Не логируем stack trace, чтобы избежать утечки seed фразы
            });
        }
        
        // Если ивент еще активен, обновляем закрепленное сообщение и отправляем ответ пользователю
        if (pumpDumpEvent.isActive) {
            updateEventMessage(chatId).catch(err => {
                console.error(`[/PUMP] Error updating event message:`, err.message);
            });
            // Отправляем ответ пользователю
            bot.sendMessage(chatId, `📈 PUMP! Текущий результат: ${currentResult > 0 ? '+' : ''}${currentResult}`).catch(err => {
                console.error(`[/PUMP] Error sending message:`, err.message);
            });
        }
    } catch (err) {
        eventLock = false;
        throw err;
    }
});

// ==================== КОМАНДА /DUMP ====================
bot.onText(/^\/dump(?:\s|$)/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    
    console.log(`[/DUMP] 🔔 Command received from user ${userId} in chat ${chatId}`);

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        console.log(`[/DUMP] ❌ Access denied: chat ${chatId} is not allowed (allowed: ${ALLOWED_PUMP_DUMP_CHAT_ID})`);
        return; // Просто игнорируем команду
    }

    // Проверяем, является ли пользователь админом (кроме ID 367102417)
    if (userId && userId !== 367102417) {
        const userIsAdmin = await isAdmin(chatId, userId);
        if (userIsAdmin) {
            console.log(`[/DUMP] ❌ Admin ${userId} tried to use /dump command`);
            return bot.sendMessage(chatId, 'Админы не могут участовать в PUMP или DUMP $TONDEV. Снимите с себя админку и попробуйте позже');
        }
    }

    // Проверяем, запущен ли ивент
    if (!pumpDumpEvent.isActive) {
        return bot.sendMessage(chatId, 'На данный момент нет актуальных ивентов по дампу или пампу TONDEV. Обратись к админам чата, чтобы они запустили ивент');
    }

    // Защита от race conditions с retry механизмом
    let retryCount = 0;
    const maxRetries = 10; // До 10 попыток (1 секунда максимум)
    const retryDelay = 100; // 100ms между попытками
    
    while (eventLock && retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryCount++;
    }
    
    if (eventLock) {
        // Если после всех попыток блокировка все еще активна, отправляем ответ
        bot.sendMessage(chatId, `⏳ Команда обрабатывается, попробуйте через секунду...`).catch(() => {});
        return; // Игнорируем команду если идет обработка
    }
    
    eventLock = true;
    try {
        // Проверяем, что ивент еще активен (мог быть завершен другим процессом)
        if (!pumpDumpEvent.isActive) {
            console.log(`[/DUMP] ⚠️ Event is not active, ignoring command`);
            return;
        }
        
        // Уменьшаем finishResult на 1
        pumpDumpEvent.finishResult -= 1;
        const currentResult = pumpDumpEvent.finishResult;
        saveState(); // Асинхронное сохранение без await
        
        console.log(`[/DUMP] ✅ -1 to finishResult, new value: ${currentResult}`);
        
        // Снимаем блокировку перед проверкой завершения
        eventLock = false;
        
        // Проверяем, не достигнут ли порог (используем кэш порогов)
        // Проверяем isActive еще раз после снятия блокировки
        if (pumpDumpEvent.isActive && !isProcessingTransaction) {
            // Вызываем проверку - она сама установит блокировку если нужно
            checkEventCompletion(chatId).catch(err => {
                // Логируем ошибку без деталей, чтобы не выдать чувствительную информацию
                console.error(`[/DUMP] ❌ Error in checkEventCompletion:`, err.message);
                // Не логируем stack trace, чтобы избежать утечки seed фразы
            });
        }
        
        // Если ивент еще активен, обновляем закрепленное сообщение и отправляем ответ пользователю
        if (pumpDumpEvent.isActive) {
            updateEventMessage(chatId).catch(err => {
                console.error(`[/DUMP] Error updating event message:`, err.message);
            });
            // Отправляем ответ пользователю
            bot.sendMessage(chatId, `📉 DUMP! Текущий результат: ${currentResult > 0 ? '+' : ''}${currentResult}`).catch(err => {
                console.error(`[/DUMP] Error sending message:`, err.message);
            });
        }
    } catch (err) {
        eventLock = false;
        console.error(`[/DUMP] ❌ Unexpected error:`, err.message);
    }
});

// ==================== КОМАНДА /EVENTSTATUS ====================
bot.onText(/\/eventstatus$/i, async (msg) => {
    const chatId = msg.chat.id;

    // Проверяем, что команда отправлена в разрешенном чате
    if (ALLOWED_PUMP_DUMP_CHAT_ID !== null && chatId !== ALLOWED_PUMP_DUMP_CHAT_ID) {
        return; // Просто игнорируем команду
    }

    const status = pumpDumpEvent.isActive ? '🟢 Активен' : '🔴 Не активен';
    const result = pumpDumpEvent.finishResult > 0 ? `+${pumpDumpEvent.finishResult}` : `${pumpDumpEvent.finishResult}`;
    const threshold = FINISH_THRESHOLD;
    
    await bot.sendMessage(chatId, 
        `📊 <b>Статус ивента</b>\n\n` +
        `Статус: ${status}\n` +
        `Текущий результат: ${result}\n` +
        `Порог завершения: ±${threshold}`,
        { parse_mode: 'HTML' }
    );
});

// ==================== ЗАПУСК ====================
// Загружаем сохраненное состояние при старте
(async () => {
  await loadState();
  
  console.log('Bot started. Pump/Dump event system ready.');
  console.log(`Allowed chat ID: ${ALLOWED_PUMP_DUMP_CHAT_ID || 'all chats (protection disabled)'}`);
  console.log(`Shop mode: ${FREE_SHOP_MODE ? '🧪 FREE TEST MODE (items granted without payment)' : '💰 NORMAL MODE (Stars payment required)'}`);
  console.log(`Transactions: ${DISABLE_TRANSACTIONS ? '🚫 DISABLED (test mode - no buy/sell TONDEV)' : '✅ ENABLED (production mode)'}`);
})();

process.on('unhandledRejection', console.error);
process.on('SIGINT', async () => { 
  await saveState(); 
  console.log('Bot stopped'); 
  process.exit(0); 
});
