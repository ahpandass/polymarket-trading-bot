# Polymarket Bot: Deposit Instructions

## Problem Summary
Your bot was failing with "invalid signature" errors because of incorrect address configuration.

## ✅ What Was Fixed
1. **Wrong configuration** (causing errors):
   - `PROXY_WALLET_ADDRESS` was set to signer address: `0x3C724Bf3394dE955Fd9Bf2FF10fBDE7F29EAB40d`

2. **Correct configuration** (now fixed in `.env`):
   - `PROXY_WALLET_ADDRESS` = `0x4411dD01B090bdef677f964c7092Ca6C4FF24619` (maker/profile wallet)
   - `POLYMARKET_PRIVATE_KEY` remains unchanged (signer: `0x3C724Bf3394dE955Fd9Bf2FF10fBDE7F29EAB40d`)

## ⚠️ Remaining Issue
You have $8.99 USDC in your wallet (`0x4411dD01B090bdef677f964c7092Ca6C4FF24619`) but **it's not deposited to Polymarket's trading contract**.

**On-chain wallet balance ≠ Trading balance**

## 🚀 How to Deposit Funds

### Step 1: Visit Polymarket Website
1. Go to [https://polymarket.com](https://polymarket.com)
2. Click "Connect Wallet" in top right
3. Connect with wallet address: `0x3C724Bf3394dE955Fd9Bf2FF10fBDE7F29EAB40d`

### Step 2: Deposit USDC to Trading Contract
1. After connecting, click on your wallet balance in top right
2. Click "Deposit"
3. Select USDC as the token
4. Enter amount (at least $1 for testing)
5. Follow the transaction prompts

**Important**: This step moves USDC from your wallet to Polymarket's trading smart contract. Simply having USDC in your wallet is not enough.

### Step 3: Verify Deposit
1. After depositing, check your trading balance on Polymarket
2. It should now show the deposited amount
3. The CLOB API will now report the correct balance

## 🔧 Test Your Bot

After depositing:

```bash
npm run dev
```

The bot will:
1. Find active BTC 15-minute markets
2. Place $1 trades (as configured in `trade.toml`)
3. Automatically trade according to your strategy

## 📋 Your Current Configuration

### `.env` file:
```
POLYMARKET_PRIVATE_KEY=0x25e36d96c7e25452b3a081632421c326cddbc2c8c723e42a772f59e972db517f
PROXY_WALLET_ADDRESS=0x4411dD01B090bdef677f964c7092Ca6C4FF24619
```

### `trade.toml` file:
- Strategy: `trade_2`
- Trade amount: `$1`
- Market: BTC 15-minute

## 🎯 Verification

To verify everything works after depositing:

```bash
npx tsx final-test-order.ts
```

This will attempt to place a $1 test order. If successful, your bot is ready!

## ❓ Common Questions

**Q: Why do I need to deposit through the website? Can't I just send USDC to the address?**
A: Polymarket uses a separate trading contract. Depositing through their interface creates the necessary approvals and moves funds to the correct contract.

**Q: How much should I deposit?**
A: Start with $5-10 for testing. The bot trades $1 per order as configured.

**Q: What if I still get errors after depositing?**
A: Run the test script above. If it works, the bot should work. If not, check the error message and ensure your API credentials are still valid.

## 📞 Support

If issues persist after depositing:
1. Check browser console for any Polymarket website errors
2. Ensure you're connected with the correct wallet (`0x3C724Bf3394dE955Fd9Bf2FF10fBDE7F29EAB40d`)
3. Verify the deposit transaction succeeded on PolygonScan