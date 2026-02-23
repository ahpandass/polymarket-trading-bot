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

// Helper functions to match CLOB client rounding logic
function decimalPlaces(num: number): number {
    if (Number.isInteger(num)) {
        return 0;
    }
    const arr = num.toString().split(".");
    if (arr.length <= 1) {
        return 0;
    }
    return arr[1]?.length || 0;
}

function roundDown(num: number, decimals: number): number {
    if (decimalPlaces(num) <= decimals) {
        return num;
    }
    return Math.floor(num * 10 ** decimals) / 10 ** decimals;
}

function roundUp(num: number, decimals: number): number {
    if (decimalPlaces(num) <= decimals) {
        return num;
    }
    return Math.ceil(num * 10 ** decimals) / 10 ** decimals;
}

function roundNormal(num: number, decimals: number): number {
    if (decimalPlaces(num) <= decimals) {
        return num;
    }
    return Math.round((num + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
}

/**
 * Calculate BUY order amounts that guarantee API constraints AFTER library processing.
 * The library's behavior appears to be:
 * 1. Round USD amount to 2 decimal places
 * 2. Ensure USD scaled amount ends with 00
 * 3. Calculate token scaled amount = round(USD scaled amount / price)
 * 
 * We need to pre-adjust amounts so the library's adjustments still satisfy API constraints.
 */
function calculateBuyOrderAmounts(
    tradeAmount: number,  // in USD
    price: number         // token price in USD
): { usdAmount: number; tokenAmount: number; usdScaled: number; tokenScaled: number } | null {
    console.log("🔍 calculateBuyOrderAmounts input:", { 
        tradeAmount, 
        price,
        humanReadable: { tradeAmount, price }
    });
    
    // Library rounds USD to 2 decimal places, so we should too
    // Start with maximum USD amount that's already rounded to 2 decimal places
    let usdAmount = Math.floor(tradeAmount * 100) / 100;
    
    // Minimum tradable amount
    const MIN_USD_AMOUNT = 0.01;
    
    // We'll search for USD amounts in 0.01 increments
    while (usdAmount >= MIN_USD_AMOUNT) {
        // Step 1: Library rounds USD to 2 decimal places (already done)
        const libraryUsdAmount = usdAmount;
        
        // Step 2: Library ensures USD scaled amount ends with 00
        const usdScaled = Math.round(libraryUsdAmount * 1e6);
        const adjustedUsdScaled = usdScaled - (usdScaled % 100);
        const finalLibraryUsdAmount = adjustedUsdScaled / 1e6;
        
        // Step 3: Library calculates token scaled amount
        // Based on error logs: tokenScaled = round(finalLibraryUsdAmount * 1e6 / price)
        const tokenScaledNumerator = finalLibraryUsdAmount * 1e6;
        const libraryTokenScaled = Math.round(tokenScaledNumerator / price);
        
        // Final token amount after library processing
        const finalLibraryTokenAmount = libraryTokenScaled / 1e6;
        
        // Now check if library's final amounts satisfy ALL API constraints
        
        // Constraint 1: USD scaled amount must end with 00 (should be true by construction)
        if (adjustedUsdScaled % 100 !== 0) {
            usdAmount -= 0.01;
            continue;
        }
        
        // Constraint 2: Token scaled amount must end with 0000
        // This is the key constraint that's been failing
        if (libraryTokenScaled % 10000 !== 0) {
            usdAmount -= 0.01;
            continue;
        }
        
        // Constraint 3: Human-readable USD amount must have ≤ 4 decimal places
        const usdStr = finalLibraryUsdAmount.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        if (usdDecimalPlaces > 4) {
            usdAmount -= 0.01;
            continue;
        }
        
        // Constraint 4: Human-readable token amount must have ≤ 2 decimal places
        const tokenStr = finalLibraryTokenAmount.toString();
        const tokenDecimalPlaces = tokenStr.includes('.') ? (tokenStr.split('.')[1]?.length || 0) : 0;
        if (tokenDecimalPlaces > 2) {
            usdAmount -= 0.01;
            continue;
        }
        
        // Constraint 5: Must not exceed available funds
        if (finalLibraryUsdAmount > tradeAmount) {
            usdAmount -= 0.01;
            continue;
        }
        
        // Constraint 6: Mathematical consistency (USD = token * price)
        const expectedUsd = finalLibraryTokenAmount * price;
        if (Math.abs(finalLibraryUsdAmount - expectedUsd) > 0.0001) {
            usdAmount -= 0.01;
            continue;
        }
        
        // All constraints satisfied!
        console.log("✅ Found guaranteed library-compatible amounts:", {
            usdAmount: finalLibraryUsdAmount,
            tokenAmount: finalLibraryTokenAmount,
            usdScaled: adjustedUsdScaled,
            tokenScaled: libraryTokenScaled,
            usdDecimalPlaces,
            tokenDecimalPlaces,
            usdScaledLast2: adjustedUsdScaled % 100,
            tokenScaledLast4: libraryTokenScaled % 10000,
            efficiency: (finalLibraryUsdAmount / tradeAmount * 100).toFixed(1) + '%',
            libraryAdjustment: `${usdAmount} -> ${finalLibraryUsdAmount} USD`
        });
        
        return {
            usdAmount: finalLibraryUsdAmount,
            tokenAmount: finalLibraryTokenAmount,
            usdScaled: adjustedUsdScaled,
            tokenScaled: libraryTokenScaled
        };
    }
    
    console.error("❌ No guaranteed amounts found with primary search");
    
    // Try alternative search: brute force all combinations
    console.log("🔄 Trying exhaustive brute force search...");
    
    // Search ALL possible USD amounts (in 0.01 increments) and token amounts (in 0.01 increments)
    // that satisfy constraints directly
    const maxUsd = Math.min(tradeAmount, 1.0);
    
    for (let usd = maxUsd; usd >= 0.01; usd -= 0.01) {
        const usdRounded = parseFloat(usd.toFixed(2));
        const usdScaled = Math.round(usdRounded * 1e6);
        
        // USD scaled must end with 00
        if (usdScaled % 100 !== 0) continue;
        
        // Calculate token amount
        const tokenAmount = usdRounded / price;
        const tokenAmountRounded = Math.floor(tokenAmount * 100) / 100; // Round down to 2 decimals
        
        if (tokenAmountRounded <= 0) continue;
        
        const tokenScaled = Math.round(tokenAmountRounded * 1e6);
        
        // Token scaled must end with 0000
        if (tokenScaled % 10000 !== 0) continue;
        
        // Recalculate USD to ensure consistency
        const finalUsdAmount = tokenAmountRounded * price;
        const finalUsdAmountRounded = parseFloat(finalUsdAmount.toFixed(4));
        const finalUsdScaled = Math.round(finalUsdAmountRounded * 1e6);
        
        // Final checks
        if (finalUsdScaled % 100 !== 0) continue;
        if (finalUsdAmountRounded > tradeAmount) continue;
        
        // Check decimal places
        const usdStr = finalUsdAmountRounded.toString();
        const tokenStr = tokenAmountRounded.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        const tokenDecimalPlaces = tokenStr.includes('.') ? (tokenStr.split('.')[1]?.length || 0) : 0;
        
        if (usdDecimalPlaces > 4 || tokenDecimalPlaces > 2) continue;
        
        console.log("✅ Found brute force guaranteed amounts:", {
            usdAmount: finalUsdAmountRounded,
            tokenAmount: tokenAmountRounded,
            usdScaled: finalUsdScaled,
            tokenScaled,
            usdDecimalPlaces,
            tokenDecimalPlaces,
            usdScaledLast2: finalUsdScaled % 100,
            tokenScaledLast4: tokenScaled % 10000
        });
        
        return {
            usdAmount: finalUsdAmountRounded,
            tokenAmount: tokenAmountRounded,
            usdScaled: finalUsdScaled,
            tokenScaled
        };
    }
    
    console.error("❌ All search strategies failed");
    console.error("Search parameters:", {
        tradeAmount,
        price,
        maxUsd: Math.min(tradeAmount, 1.0),
        minUsd: 0.01
    });
    
    return null;
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

        // Use the mathematical solution that guarantees ALL API constraints
        const result = calculateBuyOrderAmounts(tradeAmount, price);
        if (!result) {
            console.error("Cannot buy up token: unable to calculate amounts satisfying all API constraints");
            return;
        }
        
        const { usdAmount, tokenAmount, usdScaled, tokenScaled } = result;
        
        // Additional validation
        if (usdAmount <= 0 || tokenAmount <= 0 || 
            isNaN(usdAmount) || isNaN(tokenAmount) || 
            !isFinite(usdAmount) || !isFinite(tokenAmount)) {
            console.error("Cannot buy up token: invalid amounts after mathematical calculation");
            return;
        }
        
        // Verify constraints explicitly
        const usdStr = usdAmount.toString();
        const tokenStr = tokenAmount.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        const tokenDecimalPlaces = tokenStr.includes('.') ? (tokenStr.split('.')[1]?.length || 0) : 0;
        
        if (usdDecimalPlaces > 4) {
            console.error("Cannot buy up token: USD amount has more than 4 decimal places", { usdAmount, usdDecimalPlaces });
            return;
        }
        
        if (tokenDecimalPlaces > 2) {
            console.error("Cannot buy up token: token amount has more than 2 decimal places", { tokenAmount, tokenDecimalPlaces });
            return;
        }
        
        // Verify scaled amounts satisfy constraints
        if (usdScaled % 100 !== 0) {
            console.error("Cannot buy up token: USD scaled amount last 2 digits not zero", { 
                usdAmount, 
                usdScaled, 
                usdScaledLast2: usdScaled % 100 
            });
            return;
        }
        
        if (tokenScaled % 10000 !== 0) {
            console.error("Cannot buy up token: token scaled amount last 4 digits not zero", { 
                tokenAmount, 
                tokenScaled, 
                tokenScaledLast4: tokenScaled % 10000 
            });
            return;
        }

        console.log("Buying up token", { 
            tokenID: this.upTokenId, 
            price: price, 
            usdAmount: usdAmount,
            tokenAmount: tokenAmount,
            originalUsd: tradeAmount,
            usdScaled: usdScaled,
            tokenScaled: tokenScaled,
            usdDecimalPlaces,
            tokenDecimalPlaces
        });

        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
        // For BUY orders, amount should be in USD, not token size
            const order = await retryWithInstantRetry(
                async () => {
                    console.log("📤 Sending order with amounts:", {
                        usdAmount,
                        tokenAmount,
                        usdScaled,
                        tokenScaled,
                        price
                    });
                    
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
                    usdAmount,
                    tokenAmount,
                    price,
                    usdDecimalPlaces,
                    tokenDecimalPlaces,
                    usdScaled,
                    tokenScaled,
                    usdScaledLast2: usdScaled % 100,
                    tokenScaledLast4: tokenScaled % 10000
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

        // Use the same mathematical solution as buyUpToken that guarantees ALL API constraints
        const result = calculateBuyOrderAmounts(tradeAmount, price);
        if (!result) {
            console.error("Cannot buy down token: unable to calculate amounts satisfying all API constraints");
            return;
        }
        
        const { usdAmount, tokenAmount, usdScaled, tokenScaled } = result;
        
        // Additional validation
        if (usdAmount <= 0 || tokenAmount <= 0 || 
            isNaN(usdAmount) || isNaN(tokenAmount) || 
            !isFinite(usdAmount) || !isFinite(tokenAmount)) {
            console.error("Cannot buy down token: invalid amounts after mathematical calculation");
            return;
        }
        
        // Verify constraints explicitly
        const usdStr = usdAmount.toString();
        const tokenStr = tokenAmount.toString();
        const usdDecimalPlaces = usdStr.includes('.') ? (usdStr.split('.')[1]?.length || 0) : 0;
        const tokenDecimalPlaces = tokenStr.includes('.') ? (tokenStr.split('.')[1]?.length || 0) : 0;
        
        if (usdDecimalPlaces > 4) {
            console.error("Cannot buy down token: USD amount has more than 4 decimal places", { usdAmount, usdDecimalPlaces });
            return;
        }
        
        if (tokenDecimalPlaces > 2) {
            console.error("Cannot buy down token: token amount has more than 2 decimal places", { tokenAmount, tokenDecimalPlaces });
            return;
        }
        
        // Verify scaled amounts satisfy constraints
        if (usdScaled % 100 !== 0) {
            console.error("Cannot buy down token: USD scaled amount last 2 digits not zero", { 
                usdAmount, 
                usdScaled, 
                usdScaledLast2: usdScaled % 100 
            });
            return;
        }
        
        if (tokenScaled % 10000 !== 0) {
            console.error("Cannot buy down token: token scaled amount last 4 digits not zero", { 
                tokenAmount, 
                tokenScaled, 
                tokenScaledLast4: tokenScaled % 10000 
            });
            return;
        }

        console.log("Buying down token", { 
            tokenID: this.downTokenId, 
            price: price, 
            usdAmount: usdAmount,
            tokenAmount: tokenAmount,
            originalUsd: tradeAmount,
            usdScaled: usdScaled,
            tokenScaled: tokenScaled
        });

        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // For BUY orders, amount should be in USD, not token size
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            const order = await retryWithInstantRetry(
                async () => {
                    console.log("📤 Sending order with amounts:", {
                        usdAmount,
                        tokenAmount,
                        usdScaled,
                        tokenScaled,
                        price,
                        usdAmountString: usdAmount.toString(),
                        tokenAmountString: tokenAmount.toString()
                    });
                    
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
                    usdScaled: usdScaled,
                    tokenScaled: tokenScaled,
                    usdScaledLast2: usdScaled % 100,
                    tokenScaledLast4: tokenScaled % 10000
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

        // Additional price validation: price should be between 0.01 and 0.99 for up tokens
        // If price is too extreme, library may fail to calculate market price
        const validatedPrice = Math.max(0.01, Math.min(0.99, price));
        if (Math.abs(validatedPrice - price) > 0.001) {
            console.warn(`⚠️  Price adjusted from ${price} to ${validatedPrice} to avoid extreme values`);
        }

        console.log("selling up token", { 
            tokenID: this.upTokenId, 
            price: validatedPrice, 
            originalPrice: price,
            size, 
            sizeHuman: actualBalance,
            rawBalance: upBalance.balance,
            share: this.share,
            amountFormat: {
                rawWei: size,
                humanTokens: actualBalance,
                price: validatedPrice,
                expectedUsd: actualBalance * validatedPrice
            }
        });
        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            // Provide price parameter to help library calculate market price
            const order = await retryWithInstantRetry(
                async () => {
                    console.log("📤 Sending sell order with detailed info:", {
                        tokenID: this.upTokenId,
                        sizeRaw: size,
                        sizeHuman: actualBalance,
                        price: validatedPrice,
                        side: "SELL",
                        orderType: "FAK",
                        amountValidation: {
                            isInteger: Number.isInteger(size),
                            isFinite: isFinite(size),
                            isPositive: size > 0,
                            toString: size.toString()
                        }
                    });
                    
                        amount: size, // Raw wei amount
                        price: validatedPrice, // Provide price to help calculate market price
                        side: Side.SELL,
                    }, undefined, OrderTPrice, // ypovede pri.e to help calculate market price
                        side: Side.SELL,
                    }, undefined, OrderType.FAK); // FAK allows partial fills, FOK requirFs full fillAK); // FAK allows partial fills, FOK requires full fill

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
            
            // Detailed error analysis
            if (error?.message?.includes("no match")) {
                console.error("💡 'no match' error analysis:");
                console.error("   - This usually means the library couldn't calculate a market price");
                console.error("   - Possible causes:");
                console.error("     1. Price parameter may be invalid or too extreme");
                console.error("     2. Order book may have insufficient liquidity");
                console.error("     3. Amount format may be incorrect");
                console.error("   - Attempted parameters:", {
                    tokenID: this.upTokenId,
                    amount: size,
                    amountHuman: actualBalance,
                    price: validatedPrice,
                    side: "SELL"
                });
            }
            
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            
            // Log raw error details for debugging
            console.error("Raw error details:", {
                error,
                status: error?.status,
                data: error?.data,
                message: error?.message
            });
            
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

        // Additional price validation: price should be between 0.01 and 0.99 for down tokens
        // If price is too extreme, library may fail to calculate market price
        const validatedPrice = Math.max(0.01, Math.min(0.99, price));
        if (Math.abs(validatedPrice - price) > 0.001) {
            console.warn(`⚠️  Price adjusted from ${price} to ${validatedPrice} to avoid extreme values`);
        }

        console.log("selling down token", { 
            tokenID: this.downTokenId, 
            price: validatedPrice, 
            originalPrice: price,
            size, 
            sizeHuman: actualBalance,
            rawBalance: downBalance.balance,
            share: this.share,
            amountFormat: {
                rawWei: size,
                humanTokens: actualBalance,
                price: validatedPrice,
                expectedUsd: actualBalance * validatedPrice
            }
        });
        try {
            GLOBAL_TX_PROCESS.current = TxProcess.Working;
            
            const maxRetries = globalThis.__CONFIG__?.max_retries || 3;
            
            // Use FAK (Fill and Kill) instead of FOK to allow partial fills
            // Provide price parameter to help library calculate market price
            const order = await retryWithInstantRetry(
                async () => {
                    console.log("📤 Sending sell order with detailed info:", {
                        tokenID: this.downTokenId,
                        sizeRaw: size,
                        sizeHuman: actualBalance,
                        price: validatedPrice,
                        side: "SELL",
                        orderType: "FAK",
                        amountValidation: {
                            isInteger: Number.isInteger(size),
                            isFinite: isFinite(size),
                            isPositive: size > 0,
                            toString: size.toString()
                        }
                    });
                    
                    // Try with different amount formats if needed
                    // First try: raw wei amount (as we've been doing)
                    const result = await this.authorizedClob.createAndPostMarketOrder({
                        tokenID: this.downTokenId,
                        amount: size, // Raw wei amount
                        price: validatedPrice, // Provide price to help calculate market price
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
            
            // Detailed error analysis
            if (error?.message?.includes("no match")) {
                console.error("💡 'no match' error analysis:");
                console.error("   - This usually means the library couldn't calculate a market price");
                console.error("   - Possible causes:");
                console.error("     1. Price parameter may be invalid or too extreme");
                console.error("     2. Order book may have insufficient liquidity");
                console.error("     3. Amount format may be incorrect");
                console.error("   - Attempted parameters:", {
                    tokenID: this.downTokenId,
                    amount: size,
                    amountHuman: actualBalance,
                    price: validatedPrice,
                    side: "SELL"
                });
            }
            
            if (error?.status === 401 || error?.data?.error?.includes("Unauthorized")) {
                console.error("⚠️  API authentication failed. Please check your API_KEY, SECRET_KEY, and PASSPHASE in your .env file.");
            }
            
            // Log raw error details for debugging
            console.error("Raw error details:", {
                error,
                status: error?.status,
                data: error?.data,
                message: error?.message
            });
            
            return false;
        } finally {
            GLOBAL_TX_PROCESS.current = TxProcess.Idle;
        }
    };
}