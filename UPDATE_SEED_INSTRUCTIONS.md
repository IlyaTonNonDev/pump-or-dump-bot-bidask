# Инструкция: Обновление seed фразы

## Шаг 1: Зашифровать правильную seed фразу

Выполните в терминале:
```bash
cd /Users/ilabulycev/BidaskAdminTrades/pump-or-dump-bot
node encrypt_seed.js "ваша seed фраза от кошелька UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty"
```

**Важно:** Используйте seed фразу именно от кошелька `UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty`

## Шаг 2: Скопировать полученные значения

Скрипт выведет что-то вроде:
```
ENCRYPTED_WALLET_SEED=пример_зашифрованной_фразы:длинная_строка_с_зашифрованными_данными
ENCRYPTION_KEY=пример_64_символьного_hex_ключа_шифрования
ENCRYPTION_IV=пример_32_символьного_hex_iv
```

## Шаг 3: Обновить secretkeys.env

Откройте файл `secretkeys.env` и замените строки 9, 13, 14 на новые значения:

**Было:**
```env
ENCRYPTED_WALLET_SEED=старое_значение
ENCRYPTION_KEY=старое_значение
ENCRYPTION_IV=старое_значение
```

**Стало:**
```env
ENCRYPTED_WALLET_SEED=новое_значение_из_шага_2
ENCRYPTION_KEY=новое_значение_из_шага_2
ENCRYPTION_IV=новое_значение_из_шага_2
```

## Шаг 4: Проверить адрес

Выполните:
```bash
node check_wallet_address.js
```

Должен показать адрес `UQD0CRvpdtAKGaWtxjft3vQmf5xAwdOr6nWa42LTCbRRwuty` ✅

## Шаг 5: Перезапустить бота

```bash
pkill -f "node bot.js"
npm start
```

## Альтернатива: Использовать setup_keys.js (автоматически обновит файл)

```bash
node setup_keys.js
```

Скрипт:
1. Попросит ввести seed фразу
2. Автоматически зашифрует
3. Автоматически обновит `secretkeys.env`
4. Не нужно вручную копировать значения!
