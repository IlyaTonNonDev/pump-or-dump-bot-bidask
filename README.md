# Pump or Dump Bot

Telegram bot for managing Pump/Dump events for TONDEV token. Allows community members to vote on whether to pump or dump the token through a voting system.

## Features

- **Event Management**: Administrators can start new Pump/Dump events
- **Community Voting**: Users vote using `/pump` (+1) or `/dump` (-1) commands
- **Dynamic Thresholds**: Pump/Dump thresholds are calculated automatically based on TONDEV/TON ratio on wallet balance
- **Threshold Limits**: Pump thresholds range from 10 to 250, Dump thresholds range from -250 to -10
- **Fixed Thresholds**: Thresholds are fixed at event start and don't change during the event
- **Auto-completion**: Events automatically complete when threshold is reached
- **Automatic Purchase**: When PUMP event completes, bot automatically buys TONDEV tokens from BidAsk pool (keeps minimum 1 TON reserve)
- **Automatic Sale**: When DUMP event completes, bot automatically sells ALL TONDEV tokens from admin wallet
- **Pinned Messages**: Event status message is pinned in chat and updated every 4 hours
- **State Persistence**: Bot state is saved to file and restored on restart
- **Chat Protection**: Commands work only in specified chat
- **Admin Controls**: Only administrators can start new events
- **Secure Wallet**: Encrypted seed phrase storage for wallet operations (AES-256-CBC)
- **Rate Limit Handling**: Automatic retry with exponential backoff for TON API rate limits

## Commands

| Command | Description | Access |
|---------|-------------|--------|
| `/pumpOrDump` | Start a new Pump/Dump event | Admins only |
| `/pump` | Vote for PUMP (+1 to counter) | All users |
| `/dump` | Vote for DUMP (-1 to counter) | All users |
| `/eventstatus` | Show current event status and result | All users |

## How It Works

1. **Starting an Event**: An administrator runs `/pumpOrDump` to start a new event
   - Bot calculates dynamic thresholds based on current TONDEV/TON ratio
   - Thresholds are fixed at event start (won't change even if balance changes)
   - A pinned message is sent to chat with event status
2. **Voting**: Community members vote using `/pump` or `/dump` commands
   - Each command updates the pinned message immediately
   - Commands are processed with retry mechanism to handle concurrent requests
3. **Completion**: When the counter reaches the threshold:
   - **Pump threshold** (10-250): Event completes with "LEEEEET'S PUMP TONDEV❗️" message and **automatically purchases TONDEV tokens** from BidAsk pool
   - **Dump threshold** (-250 to -10): Event completes with "LEEEEET'S DUMP TONDEV❗️" message and **automatically sells ALL TONDEV tokens** from admin wallet
4. **Reminders**: Every 4 hours, bot sends a new pinned message to remind users about the active event
5. **State**: The bot saves its state to `bot_state.json` and restores it on restart

## Setup

1. Clone this repository
2. Copy `secretkeys.env.example` to `secretkeys.env`
3. Fill in your bot token in `secretkeys.env`:
   - `TELEGRAM_BOT_TOKEN` - Get from [@BotFather](https://t.me/BotFather)
   - `TON_API_KEY` - Get from [TON Console](https://tonconsole.com) (required for automatic purchases)
4. **Setup Wallet for Automatic Purchases** (optional, but required for auto-buy feature):
   - Encrypt your wallet seed phrase using the provided utility:
     ```bash
     node encrypt_seed.js "your seed phrase here"
     ```
   - Copy the generated encrypted values to `secretkeys.env`:
     - `ENCRYPTED_WALLET_SEED` - Your encrypted seed phrase
     - `ENCRYPTION_KEY` - Encryption key (32 bytes hex)
     - `ENCRYPTION_IV` - Initialization vector (16 bytes hex)
   - Set purchase amount: `BUY_AMOUNT_TON=1` (amount in TON to spend per purchase)
5. Install dependencies: `npm install`
6. Configure chat ID in `bot.js` (see Configuration section)
7. Run: `npm start`

## Configuration

Edit these values in `bot.js`:

```javascript
// Set the chat ID where commands will work
// To get chat ID, add @userinfobot to your chat or use @getidsbot
const ALLOWED_PUMP_DUMP_CHAT_ID = -5010232164; // Your chat ID (null = disable protection)

// Dynamic threshold limits
const MIN_PUMP_THRESHOLD = 10;  // Minimum pump threshold (never less than 10)
const MAX_PUMP_THRESHOLD = 250; // Maximum pump threshold (never more than 250)
const MIN_DUMP_THRESHOLD = 250; // Minimum dump threshold (absolute value, check: finishResult <= -250)
const MAX_DUMP_THRESHOLD = 10;  // Maximum dump threshold (absolute value, check: finishResult <= -10)
```

**Dynamic Thresholds**: Thresholds are calculated automatically based on TONDEV/TON ratio:
- When TONDEV is low relative to TON → Pump threshold is higher (closer to 250), Dump threshold is lower (closer to 10)
- When TONDEV is high relative to TON → Pump threshold is lower (closer to 10), Dump threshold is higher (closer to 250)
- Thresholds are fixed at event start and don't change during the event

### Getting Chat ID

To get your chat ID:
1. Add [@userinfobot](https://t.me/userinfobot) to your chat, or
2. Use [@getidsbot](https://t.me/getidsbot)

## Security

- Commands only work in the specified chat (`ALLOWED_PUMP_DUMP_CHAT_ID`)
- `/pumpOrDump` command is restricted to chat administrators only
- Other commands are available to all users in the allowed chat
- **Wallet Security**: 
  - Seed phrase is encrypted using AES-256-CBC encryption
  - `secretkeys.env` file permissions are automatically set to 600 (owner read/write only)
  - Seed phrase is never logged or exposed in error messages
- **File Security**:
  - `secretkeys.env` is in `.gitignore` and will never be committed
  - Scripts automatically set file permissions to 600 when creating `secretkeys.env`
  - Never commit `secretkeys.env` to version control
- **Important**: Store encryption keys securely and never share them

## State Management

The bot saves its state to `bot_state.json`:
- Event active status
- Current counter value
- State is automatically restored when the bot restarts

## Automatic Purchase Feature

### Automatic Purchase (PUMP)

When a PUMP event reaches the threshold (+5 by default), the bot will:
1. Send the completion message to the chat
2. Check wallet balance and ensure 1 TON reserve remains
3. Automatically execute a purchase of TONDEV tokens from the BidAsk pool
4. Send a confirmation message with transaction details

**Requirements for auto-purchase:**
- Valid wallet seed phrase (encrypted in `secretkeys.env`)
- Sufficient TON balance in the wallet (purchase amount + 1 TON reserve)
- Active wallet (must be initialized on blockchain)
- Valid `TON_API_KEY` for blockchain interactions

**Note**: The bot will always keep at least 1 TON on the wallet as reserve for gas fees.

### Automatic Sale (DUMP)

When a DUMP event reaches the threshold (-5 by default), the bot will:
1. Send the completion message to the chat
2. Check TONDEV token balance in admin wallet
3. Automatically sell ALL TONDEV tokens to the BidAsk pool
4. Send a confirmation message with transaction details

**Requirements for auto-sale:**
- Valid wallet seed phrase (encrypted in `secretkeys.env`)
- TONDEV tokens in the wallet (balance > 0)
- Active wallet (must be initialized on blockchain)
- Valid `TON_API_KEY` for blockchain interactions
- Sufficient TON for gas fees (~0.1 TON)

**BidAsk Pool Address**: `EQDs6EBg0IfDk1FmWqy4vBdvYDJIM4r2bk9P8TUpu1lGhoOY`

## Utilities

### Encrypt Seed Phrase

Use `encrypt_seed.js` to securely encrypt your wallet seed phrase:

```bash
node encrypt_seed.js "your twelve word seed phrase here"
```

This will generate encrypted values that you can safely store in `secretkeys.env`.

## Hosting

Works with:
- bothost.ru
- Replit
- Any Node.js hosting with environment variables support

**Note**: Ensure your hosting provider supports:
- Environment variables for secrets
- Persistent storage for `bot_state.json`
- Network access to TON blockchain APIs

## License

MIT
