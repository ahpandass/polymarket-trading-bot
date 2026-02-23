import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { Market } from "../types";
import { GLOBAL_TX_PROCESS, TxProcess } from "../constant";
import { retryWithInstantRetry } from "../utils/retry";

declare module "./index" {
    interface Trade {
        make_trading_decision(): void;
        buyUpToken(): Promise<void>;
        buyDownToken(): Promise<void>;
        sellUpToken(): Promise<boolean>;
        sellDownToken(): Promise<boolean>;
        updateTokenBalances(): Promise<void>;
        waitForBalance(tokenType: "up" | "down", timeoutMs?: number): Promise<void>;
    }
}

// Function to attach methods to Trade class (called from index.ts)
export function attachTradeMethods(TradeClass: new (...args: any[]) => any) {
    // Method to check token balances and update state
    TradeClass.prototype.updateTokenBalances = async function (): Promise<void> {
        try {
            // Check up token balance
            const upBalance = await this.authorizedClob.getBalanceAllowance({
                asset_type: AssetType.CONDITIONAL,
                token_id: this.upTokenId,
            });

            // Check down token balance
            const downBalance = await this.authorizedClob.getBalanceAllowance({
                asset_type: AssetType.CONDITIONAL,
                token_id: this.downTokenId,
            });

            // Check USD (COLLATERAL) balance
            const usdBalance = await this.authorizedClob.getBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            });
            
            console.log("upBalance", upBalance);
            console.log("downBalance", downBalance);
            console.log("usdBalance", usdBalance);

            // Update balances (convert from string to number, balance is in wei, divide by 1e6 for USD)
            const upBalanceNum = parseFloat(upBalance.balance) / 1e6;
            const downBalanceNum = parseFloat(downBalance.balance) / 1e6;
            const usdBalanceNum = parseFloat(usdBalance.balance) / 1e6;

            // Update state based on balances
            if (upBalanceNum > 0) {
                this.share = upBalanceNum;
                this.holdingStatus = Market.Up;
                this.usd = usdBalanceNum;
            } else if (downBalanceNum > 0) {
                this.share = downBalanceNum;
                this.holdingStatus = Market.Down;
                this.usd = usdBalanceNum;
            } else {
                this.share = 0;
                this.holdingStatus = Market.None;
                this.usd = usdBalanceNum;
            }

            console.log(`📊 Balance updated | Up: ${upBalanceNum.toFixed(4)} | Down: ${downBalanceNum.toFixed(4)} | USD: $${usdBalanceNum.toFixed(2)}`);
        } catch (error: any) {
            console.error("❌ Error updating token balances:", error);
        }
    };

    // Method to poll balance every 1 second until balance is received
    TradeClass.prototype.waitForBalance = async function (tokenType: "up" | "down", timeoutMs: number = 60000): Promise<void> {
        const startTime = Date.now();
        const pollInterval = 1000; // 1 second
        
        console.log(`⏳ Waiting for ${tokenType} token balance...`);
        
        while (Date.now() - startTime < timeoutMs) {
            try {
                await this.updateTokenBalances();
                
                const hasBalance = tokenType === "up" 
                    ? (this.holdingStatus === Market.Up && this.share > 0)
                    : (this.holdingStatus === Market.Down && this.share > 0);
                
                if (hasBalance) {
                    console.log(`✅ ${tokenType.toUpperCase()} token balance received!`);
                    return;
                }
                
                // Wait 1 second before next check
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            } catch (error: any) {
                console.error(`❌ Error while waiting for balance:`, error);
                // Continue polling even if one check fails
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        }
        
        throw new Error(`⏱️  Timeout: ${tokenType} token balance not received within ${timeoutMs / 1000} seconds`);
    };

    TradeClass.prototype.buyUpToken = async function (): Promise<void> {
        // Only allow one buy per market
        if (this.hasBought) {
            console.log("⏭️  Already bought in this market, skipping");
            return;
        }

        if (!this.upTokenId || !this.upBuyPrice || this.upBuyPrice <= 0 || isNaN(this.upBuyPrice)) {
            console.error("Cannot buy up token: missing tokenId or invalid price");
            return;
        }

        // Calculate size based on available USD and trade_usd config
        const tradeAmount = globalThis.__CONFIG__.trade_usd || this.usd;

        if (!tradeAmount || isNaN(tradeAmount) || tradeAmount <= 0) {
            console.error("Cannot buy up token: invalid trade amount");
            return;
        }

        // Ensure price is a valid number
        const price = Number(this.upBuyPrice);
        if (isNaN(price) || !isFinite(price) || price <= 0) {
            console.error("Cannot buy up token: invalid price value");
            return;
        }

        // For BUY orders:
        // - maker amount (USD) supports max 4 decimals accuracy
        // - taker amount (tokens) supports max 2 decimals accuracy
        // We need to find token amount with max 2 decimals such that USD = token * price has max 4 decimals
        
        // Start with maximum token amount we can afford
        let tokenAmount = tradeAmount / price;
        
        // Round token amount to 2 decimal places
        tokenAmount = parseFloat(tokenAmount.toFixed(2));
        
        // Compute corresponding USD amount
        let usdAmount = tokenAmount * price;
        
        // Ensure USD amount doesn't exceed available funds
        // If it does, reduce token amount by 0.01 (smallest unit) until USD <= tradeAmount
        while (usdAmount > tradeAmount && tokenAmount > 0) {
            tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
            if (tokenAmount <= 0) {
                console.error("Cannot buy up token: insufficient funds after decimal adjustment");
                return;
            }
            usdAmount = tokenAmount * price;
        }
        
        // Check decimal constraints
        // USD amount should have <= 4 decimal places
        const usdStr = usdAmount.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        if (usdDecimalPlaces > 4) {
            // Round USD to 4 decimal places and recompute token amount
            usdAmount = parseFloat(usdAmount.toFixed(4));
            tokenAmount = usdAmount / price;
            // Re-round token to 2 decimals
            tokenAmount = parseFloat(tokenAmount.toFixed(2));
            // Recompute USD to ensure consistency
            usdAmount = tokenAmount * price;
            usdAmount = parseFloat(usdAmount.toFixed(4));
            
            // Check again for fund sufficiency
            if (usdAmount > tradeAmount) {
                tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
                if (tokenAmount <= 0) {
                    console.error("Cannot buy up token: insufficient funds after decimal rounding");
                    return;
                }
                usdAmount = tokenAmount * price;
                usdAmount = parseFloat(usdAmount.toFixed(4));
            }
        }
        
        // Final validation
        if (usdAmount <= 0 || tokenAmount <= 0 || 
            isNaN(usdAmount) || isNaN(tokenAmount) || 
            !isFinite(usdAmount) || !isFinite(tokenAmount)) {
            console.error("Cannot buy up token: invalid amounts after decimal adjustment");
            return;
        }
        
        // Additional check: scaled amounts must satisfy API constraints
        const SCALE = 1e6;
        const usdScaled = Math.round(usdAmount * SCALE);
        const tokenScaled = Math.round(tokenAmount * SCALE);
        
        // USD scaled must have last 2 digits zero (6-4=2)
        // Token scaled must have last 4 digits zero (6-2=4)
        if (usdScaled % 100 !== 0 || tokenScaled % 10000 !== 0) {
            console.error("Cannot buy up token: scaled amounts violate decimal constraints", {
                usdAmount,
                tokenAmount,
                usdScaled,
                tokenScaled,
                usdScaledLast2: usdScaled % 100,
                tokenScaledLast4: tokenScaled % 10000
            });
            // Try to adjust by reducing token amount further
            let adjusted = false;
            let attempts = 0;
            while (attempts < 100 && (usdScaled % 100 !== 0 || tokenScaled % 10000 !== 0)) {
                tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
                if (tokenAmount <= 0) break;
                usdAmount = tokenAmount * price;
                usdAmount = parseFloat(usdAmount.toFixed(4));
                const newUsdScaled = Math.round(usdAmount * SCALE);
                const newTokenScaled = Math.round(tokenAmount * SCALE);
                if (newUsdScaled % 100 === 0 && newTokenScaled % 10000 === 0) {
                    adjusted = true;
                    break;
                }
                attempts++;
            }
            
            if (!adjusted) {
                console.error("Cannot buy up token: unable to satisfy decimal constraints after adjustments");
                return;
            }
        }

        console.log("Buying up token", { 
            tokenID: this.upTokenId, 
            price: price, 
            usdAmount: usdAmount,
            tokenAmount: tokenAmount,
            originalUsd: tradeAmount,
            usdScaled: Math.round(usdAmount * SCALE),
            tokenScaled: Math.round(tokenAmount * SCALE)
        });

        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // For BUY orders, amount should be in USD, not token size
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            const order = await retryWithInstantRetry(
                async () => {
                    const result = await this.authorizedClob.createAndPostMarketOrder({
                        tokenID: this.upTokenId,
                        amount: usdAmount, // USD amount to buy
                        price: price, // Optional: specify price, otherwise uses market price
                        side: Side.BUY,
                    }, undefined, OrderType.GTC); // GTC stays in book until filled or cancelled

                    if (!result.success) {
                        throw new Error("❌ Error buying up token: " + result.error);
                    }

                    return result;
                },
                maxRetries,
                "Buy Up Token"
            );

            console.log("✅ Order posted successfully:", order);

            // Mark as bought
            this.hasBought = true;

            // Poll balance every 1 second until up token balance is received
            await this.waitForBalance("up");
        } catch (error: any) {
            console.error("❌ Error buying up token:", error);
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            // Log detailed error info for decimal issues
            if (error?.data?.error?.includes("invalid amounts") || error?.data?.error?.includes("decimals")) {
                console.error("💡 Decimal constraint error details:", {
                    usdAmount: usdAmount,
                    tokenAmount: tokenAmount,
                    price: price,
                    usdDecimals: usdAmount.toString().split('.')[1]?.length || 0,
                    tokenDecimals: tokenAmount.toString().split('.')[1]?.length || 0,
                    usdScaled: usdScaled,
                    tokenScaled: Math.round(tokenAmount * SCALE),
                    usdScaledLast2: usdScaled % 100,
                    tokenScaledLast4: Math.round(tokenAmount * SCALE) % 10000
                });
            }
        } finally {
            GLOBAL_TX_PROCESS.current = TxProcess.Idle;
        }
    };

    TradeClass.prototype.buyDownToken = async function (): Promise<void> {
        // Only allow one buy per market
        if (this.hasBought) {
            console.log("⏭️  Already bought in this market, skipping");
            return;
        }

        if (!this.downTokenId || !this.downBuyPrice || this.downBuyPrice <= 0 || isNaN(this.downBuyPrice)) {
            console.error("Cannot buy down token: missing tokenId or invalid price");
            return;
        }

        // Calculate size based on available USD and trade_usd config
        const tradeAmount = globalThis.__CONFIG__.trade_usd || this.usd;

        if (!tradeAmount || isNaN(tradeAmount) || tradeAmount <= 0) {
            console.error("Cannot buy down token: invalid trade amount");
            return;
        }

        // Ensure price is a valid number
        const price = Number(this.downBuyPrice);
        if (isNaN(price) || !isFinite(price) || price <= 0) {
            console.error("Cannot buy down token: invalid price value");
            return;
        }

        // For BUY orders:
        // - maker amount (USD) supports max 4 decimals accuracy
        // - taker amount (tokens) supports max 2 decimals accuracy
        // We need to find token amount with max 2 decimals such that USD = token * price has max 4 decimals
        
        // Start with maximum token amount we can afford
        let tokenAmount = tradeAmount / price;
        
        // Round token amount to 2 decimal places
        tokenAmount = parseFloat(tokenAmount.toFixed(2));
        
        // Compute corresponding USD amount
        let usdAmount = tokenAmount * price;
        
        // Ensure USD amount doesn't exceed available funds
        // If it does, reduce token amount by 0.01 (smallest unit) until USD <= tradeAmount
        while (usdAmount > tradeAmount && tokenAmount > 0) {
            tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
            if (tokenAmount <= 0) {
                console.error("Cannot buy down token: insufficient funds after decimal adjustment");
                return;
            }
            usdAmount = tokenAmount * price;
        }
        
        // Check decimal constraints
        // USD amount should have <= 4 decimal places
        const usdStr = usdAmount.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        if (usdDecimalPlaces > 4) {
            // Round USD to 4 decimal places and recompute token amount
            usdAmount = parseFloat(usdAmount.toFixed(4));
            tokenAmount = usdAmount / price;
            // Re-round token to 2 decimals
            tokenAmount = parseFloat(tokenAmount.toFixed(2));
            // Recompute USD to ensure consistency
            usdAmount = tokenAmount * price;
            usdAmount = parseFloat(usdAmount.toFixed(4));
            
            // Check again for fund sufficiency
            if (usdAmount > tradeAmount) {
                tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
                if (tokenAmount <= 0) {
                    console.error("Cannot buy down token: insufficient funds after decimal rounding");
                    return;
                }
                usdAmount = tokenAmount * price;
                usdAmount = parseFloat(usdAmount.toFixed(4));
            }
        }
        
        // Final validation
        if (usdAmount <= 0 || tokenAmount <= 0 || 
            isNaN(usdAmount) || isNaN(tokenAmount) || 
            !isFinite(usdAmount) || !isFinite(tokenAmount)) {
            console.error("Cannot buy down token: invalid amounts after decimal adjustment");
            return;
        }
        
        // Additional check: scaled amounts must satisfy API constraints
        const SCALE = 1e6;
        const usdScaled = Math.round(usdAmount * SCALE);
        const tokenScaled = Math.round(tokenAmount * SCALE);
        
        // USD scaled must have last 2 digits zero (6-4=2)
        // Token scaled must have last 4 digits zero (6-2=4)
        if (usdScaled % 100 !== 0 || tokenScaled % 10000 !== 0) {
            console.error("Cannot buy down token: scaled amounts violate decimal constraints", {
                usdAmount,
                tokenAmount,
                usdScaled,
                tokenScaled,
                usdScaledLast2: usdScaled % 100,
                tokenScaledLast4: tokenScaled % 10000
            });
            // Try to adjust by reducing token amount further
            let adjusted = false;
            let attempts = 0;
            while (attempts < 100 && (usdScaled % 100 !== 0 || tokenScaled % 10000 !== 0)) {
                tokenAmount = parseFloat((tokenAmount - 0.01).toFixed(2));
                if (tokenAmount <= 0) break;
                usdAmount = tokenAmount * price;
                usdAmount = parseFloat(usdAmount.toFixed(4));
                const newUsdScaled = Math.round(usdAmount * SCALE);
                const newTokenScaled = Math.round(tokenAmount * SCALE);
                if (newUsdScaled % 100 === 0 && newTokenScaled % 10000 === 0) {
                    adjusted = true;
                    break;
                }
                attempts++;
            }
            
            if (!adjusted) {
                console.error("Cannot buy down token: unable to satisfy decimal constraints after adjustments");
                return;
            }
        }

        console.log("Buying down token", { 
            tokenID: this.downTokenId, 
            price: price, 
            usdAmount: usdAmount,
            tokenAmount: tokenAmount,
            originalUsd: tradeAmount,
            usdScaled: Math.round(usdAmount * SCALE),
            tokenScaled: Math.round(tokenAmount * SCALE)
        });

        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // For BUY orders, amount should be in USD, not token size
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            const order = await retryWithInstantRetry(
                async () => {
                    const result = await this.authorizedClob.createAndPostMarketOrder({
                        tokenID: this.downTokenId,
                        amount: usdAmount, // USD amount to buy
                        price: price, // Optional: specify price, otherwise uses market price
                        side: Side.BUY,
                    }, undefined, OrderType.GTC); // GTC stays in book until filled or cancelled

                    if (!result.success) {
                        throw new Error("❌ Error buying down token: " + result.error);
                    }

                    return result;
                },
                maxRetries,
                "Buy Down Token"
            );

            console.log("✅ Order posted successfully:", order);

            // Mark as bought
            this.hasBought = true;

            // Poll balance every 1 second until down token balance is received
            await this.waitForBalance("down");
        } catch (error: any) {
            console.error("❌ Error buying down token:", error);
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            // Log detailed error info for decimal issues
            if (error?.data?.error?.includes("invalid amounts") || error?.data?.error?.includes("decimals")) {
                console.error("💡 Decimal constraint error details:", {
                    usdAmount: usdAmount,
                    tokenAmount: tokenAmount,
                    price: price,
                    usdDecimals: usdAmount.toString().split('.')[1]?.length || 0,
                    tokenDecimals: tokenAmount.toString().split('.')[1]?.length || 0,
                    usdScaled: Math.round(usdAmount * SCALE),
                    tokenScaled: Math.round(tokenAmount * SCALE),
                    usdScaledLast2: Math.round(usdAmount * SCALE) % 100,
                    tokenScaledLast4: Math.round(tokenAmount * SCALE) % 10000
                });
            }
        } finally {
            GLOBAL_TX_PROCESS.current = TxProcess.Idle;
        }
    };

    TradeClass.prototype.sellUpToken = async function (): Promise<boolean> {
        if (!this.upTokenId || !this.upSellPrice || this.upSellPrice <= 0 || isNaN(this.upSellPrice)) {
            console.error("Cannot sell up token: missing tokenId or invalid price");
            return false;
        }

        // Refresh balance from API before selling to get accurate balance
        await this.updateTokenBalances();

        // Verify we're still holding up token after balance refresh
        if (this.holdingStatus !== Market.Up || this.share <= 0) {
            console.error("Cannot sell up token: no shares available or not holding up token");
            return false;
        }

        // Get the actual balance from API to ensure we have the exact amount
        const upBalance = await this.authorizedClob.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: this.upTokenId,
        });

        // Convert balance from wei to human-readable (divide by 1e6) for validation
        const actualBalance = parseFloat(upBalance.balance) / 1e6;

        if (actualBalance <= 0 || isNaN(actualBalance) || !isFinite(actualBalance)) {
            console.error("Cannot sell up token: invalid balance from API");
            return false;
        }

        // For SELL orders, use the raw balance (in wei) as the API expects it in this format
        // The raw balance is the exact amount the API needs
        const rawBalance = parseFloat(upBalance.balance);
        
        if (rawBalance <= 0 || isNaN(rawBalance) || !isFinite(rawBalance)) {
            console.error("Cannot sell up token: invalid raw balance from API");
            return false;
        }

        // Use raw balance for the amount parameter (API expects wei format)
        const size = rawBalance;

        // Ensure price is a valid number
        const price = Number(this.upSellPrice);
        if (isNaN(price) || !isFinite(price) || price <= 0) {
            console.error("Cannot sell up token: invalid price value");
            return false;
        }

        console.log("selling up token", { 
            tokenID: this.upTokenId, 
            price: price, 
            size, 
            actualBalance, 
            rawBalance: upBalance.balance,
            share: this.share 
        });
        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            const order = await retryWithInstantRetry(
                async () => {
                    const result = await this.authorizedClob.createAndPostMarketOrder({
                        tokenID: this.upTokenId,
                        amount: size,
                        side: Side.SELL,
                    }, undefined, OrderType.GTC); // GTC stays in book until filled or cancelled

                    if (!result.success) {
                        throw new Error("❌ Error selling up token: " + result.error);
                    }

                    return result;
                },
                maxRetries,
                "Sell Up Token"
            );

            console.log("✅ Order posted successfully:", order);

            // Wait a bit for the order to settle, then check balances
            await new Promise(resolve => setTimeout(resolve, 2000));
            await this.updateTokenBalances();

            // Verify the sell was successful by checking that we no longer hold the token
            if (this.holdingStatus === Market.Up && this.share > 0) {
                console.warn("⚠️  Sell order posted but tokens still held. May need more time to settle.");
                // Still return true as the order was posted successfully
                return true;
            }

            console.log("✅ Sell confirmed: tokens successfully sold");
            return true;
        } catch (error: any) {
            console.error("❌ Error selling up token:", error);
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            return false;
        } finally {
            GLOBAL_TX_PROCESS.current = TxProcess.Idle;
        }
    };

    TradeClass.prototype.sellDownToken = async function (): Promise<boolean> {
        if (!this.downTokenId || !this.downSellPrice || this.downSellPrice <= 0 || isNaN(this.downSellPrice)) {
            console.error("Cannot sell down token: missing tokenId or invalid price");
            return false;
        }

        // Refresh balance from API before selling to get accurate balance
        await this.updateTokenBalances();

        // Verify we're still holding down token after balance refresh
        if (this.holdingStatus !== Market.Down || this.share <= 0) {
            console.error("Cannot sell down token: no shares available or not holding down token");
            return false;
        }

        // Get the actual balance from API to ensure we have the exact amount
        const downBalance = await this.authorizedClob.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: this.downTokenId,
        });

        // Convert balance from wei to human-readable (divide by 1e6) for validation
        const actualBalance = parseFloat(downBalance.balance) / 1e6;

        if (actualBalance <= 0 || isNaN(actualBalance) || !isFinite(actualBalance)) {
            console.error("Cannot sell down token: invalid balance from API");
            return false;
        }

        // For SELL orders, use the raw balance (in wei) as the API expects it in this format
        // The raw balance is the exact amount the API needs
        const rawBalance = parseFloat(downBalance.balance);
        
        if (rawBalance <= 0 || isNaN(rawBalance) || !isFinite(rawBalance)) {
            console.error("Cannot sell down token: invalid raw balance from API");
            return false;
        }

        // Use raw balance for the amount parameter (API expects wei format)
        const size = rawBalance;

        // Ensure price is a valid number
        const price = Number(this.downSellPrice);
        if (isNaN(price) || !isFinite(price) || price <= 0) {
            console.error("Cannot sell down token: invalid price value");
            return false;
        }

        console.log("selling down token", { 
            tokenID: this.downTokenId, 
            price: price, 
            size, 
            actualBalance, 
            rawBalance: downBalance.balance,
            share: this.share 
        });
        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            const order = await retryWithInstantRetry(
                async () => {
                    const result = await this.authorizedClob.createAndPostMarketOrder({
                        tokenID: this.downTokenId,
                        amount: size,
                        side: Side.SELL,
                    }, undefined, OrderType.FAK); // FAK allows partial fills, FOK requires full fill

                    if (!result.success) {
                        throw new Error("❌ Error selling down token: " + result.error);
                    }

                    return result;
                },
                maxRetries,
                "Sell Down Token"
            );

            console.log("✅ Order posted successfully:", order);

            // Wait a bit for the order to settle, then check balances
            await new Promise(resolve => setTimeout(resolve, 2000));
            await this.updateTokenBalances();

            // Verify the sell was successful by checking that we no longer hold the token
            if (this.holdingStatus === Market.Down && this.share > 0) {
                console.warn("⚠️  Sell order posted but tokens still held. May need more time to settle.");
                // Still return true as the order was posted successfully
                return true;
            }

            console.log("✅ Sell confirmed: tokens successfully sold");
            return true;
        } catch (error: any) {
            console.error("❌ Error selling down token:", error);
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            return false;
        } finally {
            GLOBAL_TX_PROCESS.current = TxProcess.Idle;
        }
    };
}