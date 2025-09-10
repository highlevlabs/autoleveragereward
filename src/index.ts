import 'dotenv/config';
import fetch from 'node-fetch';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';

// =============== ENV =================
const RPC_URL = process.env.RPC_URL!;
const DEV_PRIV = process.env.DEV_WALLET_PRIVATE_KEY!;
const DEV_PUB = process.env.DEV_WALLET_PUBLIC_KEY!;
const JUP_BASE = process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag';
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);

const EXCHANGE = (process.env.EXCHANGE || 'hyperliquid').toLowerCase();
const EX_API_BASE = process.env.EXCHANGE_API_BASE!;
const EX_API_KEY = process.env.EXCHANGE_API_KEY!;
const EX_API_SECRET = process.env.EXCHANGE_API_SECRET!;
const EX_SUBACCOUNT = process.env.EXCHANGE_SUBACCOUNT || 'default';
const EX_DEPOSIT = process.env.EXCHANGE_DEPOSIT_ADDRESS || '';

const SYMBOL = process.env.SYMBOL || 'BTC-USD';
const TRADE_NOTIONAL_USDC = Number(process.env.TRADE_NOTIONAL_USDC || '200');
const LEVERAGE = Number(process.env.LEVERAGE || '20');
const RUN_INTERVAL_MIN = Number(process.env.RUN_INTERVAL_MIN || '60');
const MIN_REWARD_USDC = Number(process.env.MIN_REWARD_USDC || '25');

// =============== STATE ===============
const STATE_FILE = './state.json';
type State = { lastProcessedSlot: number, carriedUSDC: number };
function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastProcessedSlot: 0, carriedUSDC: 0 }; }
}
function saveState(s: State) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// =============== SOLANA CORE =========
const connection = new Connection(RPC_URL, 'confirmed');
const devKeypair = Keypair.fromSecretKey(
  DEV_PRIV.startsWith('[') ? Uint8Array.from(JSON.parse(DEV_PRIV)) :
  Uint8Array.from(Buffer.from(DEV_PRIV, 'base64'))
);
const devPubkey = new PublicKey(DEV_PUB);

// Estimate new creator-fee rewards (SOL + USDC) since last slot.
// For simplicity we just check SOL balance delta + USDC ATA delta.
async function collectNewRewards(s: State) {
  const currentSlot = await connection.getSlot('confirmed');

  // SOL balance
  const lamports = await connection.getBalance(devPubkey, 'confirmed');
  // USDC balance
  const usdcAta = await getAssociatedTokenAddress(USDC_MINT, devPubkey, false);
  let usdcBal = 0;
  try {
    const usdcAcc = await connection.getTokenAccountBalance(usdcAta);
    usdcBal = Number(usdcAcc.value.amount) / Math.pow(10, usdcAcc.value.decimals);
  } catch { /* no ATA yet */ }

  // naive approach: treat whole balances as recyclable (minus carry already known)
  // In practice, track TXs from pump.fun program and sum amounts since s.lastProcessedSlot.
  return { currentSlot, lamports, usdcBal };
}

// Swap SOL→USDC via Jupiter (server-side tx build; wallet signs)
// NOTE: This is the minimalistic route—test on devnet first!
async function swapSolToUSDC(solAmount: number): Promise<number> {
  if (solAmount <= 0) return 0;

  // 1) Get quote
  const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${USDC_MINT.toBase58()}&amount=${Math.floor(solAmount * LAMPORTS_PER_SOL)}&slippageBps=50`;
  const quote = await (await fetch(quoteUrl)).json();

  if (!quote?.data?.[0]) return 0;

  // 2) Build swap transaction
  const swapResp = await fetch(`${JUP_BASE}/v6/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.data[0],
      userPublicKey: devPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  const swapData = await swapResp.json();
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');

  // 3) Sign + send
  const { VersionedTransaction } = await import('@solana/web3.js');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([devKeypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  // Roughly return USDC received from quote (conservative)
  return Number(quote.data[0].outAmount) / Math.pow(10, 6);
}

// Transfer USDC to exchange deposit (if needed)
async function transferUSDC(to: string, amount: number) {
  if (!to || amount <= 0) return;
  const toPub = new PublicKey(to);
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, devPubkey, false);
  const toAta = await getAssociatedTokenAddress(USDC_MINT, toPub, true);

  const { Transaction, SystemProgram } = await import('@solana/web3.js');
  const tx = new Transaction();
  // Create ATA for recipient if needed by sending 0 lamports (spl-token-2022 flow skipped for brevity)
  // For simplicity we just do the transfer; ensure the exchange supports Solana USDC directly.
  const decimals = 6;
  const raw = BigInt(Math.floor(amount * 10 ** decimals));
  tx.add(createTransferInstruction(fromAta, toAta, devPubkey, Number(raw), [], TOKEN_PROGRAM_ID));

  const sig = await connection.sendTransaction(tx, [devKeypair]);
  await connection.confirmTransaction(sig, 'confirmed');
}

// =============== SIGNAL ENGINE ========
import { RSI, EMA } from 'technicalindicators';

// Pull recent prices (use your preferred feed; placeholder uses exchange klines)
async function fetchCloses(symbol: string, limit = 200): Promise<number[]> {
  // You can replace with Pyth/Helius/your exchange. Here we assume an endpoint returning closes.
  const url = `${EX_API_BASE}/market/klines?symbol=${encodeURIComponent(symbol)}&interval=60m&limit=${limit}`;
  const res = await fetch(url, { headers: { 'X-API-KEY': EX_API_KEY } }).catch(() => null);
  if (!res) return [];
  const data = await res.json();
  // Expecting array of { close: number }
  return data.map((k: any) => Number(k.close)).filter((n: number) => Number.isFinite(n));
}

type Signal = 'LONG' | 'SHORT' | 'FLAT';

function makeSignal(closes: number[]): Signal {
  if (closes.length < 100) return 'FLAT';
  const rsi = RSI.calculate({ period: 14, values: closes });
  const emaFast = EMA.calculate({ period: 21, values: closes });
  const emaSlow = EMA.calculate({ period: 55, values: closes });
  const last = closes.length - 1;
  const rsiLast = rsi[rsi.length - 1];
  const fast = emaFast[emaFast.length - 1];
  const slow = emaSlow[emaSlow.length - 1];

  // Simple logic:
  // - Long if EMA21 > EMA55 AND RSI >= 52
  // - Short if EMA21 < EMA55 AND RSI <= 48
  // - Else FLAT
  if (fast > slow && rsiLast >= 52) return 'LONG';
  if (fast < slow && rsiLast <= 48) return 'SHORT';
  return 'FLAT';
}

// =============== EXCHANGE ADAPTER =====
// NOTE: Fill signing/auth per the exchange’s docs.
async function placePerpOrder(side: 'buy' | 'sell', leverage: number, notionalUSDC: number) {
  // Example placeholder body—replace with the actual Hyperliquid/Phantom route
  const body = {
    symbol: SYMBOL,
    side,
    leverage,
    type: 'market',
    notional: notionalUSDC,
    subaccount: EX_SUBACCOUNT,
    tif: 'ioc'
  };

  const res = await fetch(`${EX_API_BASE}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': EX_API_KEY,
      // Add HMAC or other auth headers as required by the exchange
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Order failed: ${res.status} ${t}`);
  }
  return res.json();
}

// =============== MAIN LOOP ============
async function run() {
  const st = loadState();

  // 1) Creator rewards snapshot
  const rewards = await collectNewRewards(st);

  // 2) Convert SOL→USDC if meaningful SOL is present (leave buffer for fees)
  const sol = rewards.lamports / LAMPORTS_PER_SOL;
  let usdcFromSol = 0;
  if (sol > 0.01) {
    const solToUse = Math.max(0, sol - 0.01); // keep 0.01 SOL for fees
    usdcFromSol = await swapSolToUSDC(solToUse);
  }

  // 3) USDC on wallet
  const totalUSDC = rewards.usdcBal + usdcFromSol + st.carriedUSDC;

  // 4) If > threshold, optionally transfer to exchange deposit
  if (EX_DEPOSIT && totalUSDC >= MIN_REWARD_USDC) {
    await transferUSDC(EX_DEPOSIT, totalUSDC);
    st.carriedUSDC = 0;
  } else {
    st.carriedUSDC = totalUSDC; // carry to next hour
  }

  // 5) Build trading signal (independent of transfer; assumes account already funded)
  const closes = await fetchCloses(SYMBOL, 300);
  const signal = makeSignal(closes);

  // 6) Place 20x order (market) if signal not FLAT
  if (signal === 'LONG') {
    await placePerpOrder('buy', LEVERAGE, TRADE_NOTIONAL_USDC);
  } else if (signal === 'SHORT') {
    await placePerpOrder('sell', LEVERAGE, TRADE_NOTIONAL_USDC);
  }

  // 7) Save state
  st.lastProcessedSlot = rewards.currentSlot;
  saveState(st);

  console.log(`[${new Date().toISOString()}] sol->usdc:${usdcFromSol.toFixed(2)} totalUSDC:${totalUSDC.toFixed(2)} signal:${signal}`);
}

// Kick off hourly
run().catch(console.error);
setInterval(() => run().catch(console.error), RUN_INTERVAL_MIN * 60 * 1000);
