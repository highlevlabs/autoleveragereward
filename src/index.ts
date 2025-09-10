import 'dotenv/config';
import fetch from 'node-fetch';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadState, saveState } from './utils/state.js';
import { log, warn, error } from './utils/logger.js';
import { makeSignal } from './indicators/signal.js';
import { ExchangeAdapter } from './adapters/exchange.js';
import { PaperExchange } from './adapters/paper.js';
import { HyperliquidAdapter } from './adapters/hyperliquid.js';

// ---------- ENV ----------
const RPC_URL = process.env.RPC_URL!;
const DEV_PRIV = process.env.DEV_WALLET_PRIVATE_KEY!;
const DEV_PUB = process.env.DEV_WALLET_PUBLIC_KEY!;
const JUP_BASE = process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag';
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);

const EXCHANGE = (process.env.EXCHANGE || 'paper').toLowerCase();
const EX_API_BASE = process.env.EXCHANGE_API_BASE || '';
const EX_API_KEY = process.env.EXCHANGE_API_KEY || '';
const EX_API_SECRET = process.env.EXCHANGE_API_SECRET || '';
const EX_SUBACCOUNT = process.env.EXCHANGE_SUBACCOUNT || 'default';
const EX_DEPOSIT = process.env.EXCHANGE_DEPOSIT_ADDRESS || '';

const SYMBOL = process.env.SYMBOL || 'BTC-USD';
const TRADE_NOTIONAL_USDC = Number(process.env.TRADE_NOTIONAL_USDC || '200');
const LEVERAGE = Number(process.env.LEVERAGE || '20');
const RUN_INTERVAL_MIN = Number(process.env.RUN_INTERVAL_MIN || '60');
const MIN_REWARD_USDC = Number(process.env.MIN_REWARD_USDC || '25');

// ---------- STATE / SOL ----------
const connection = new Connection(RPC_URL, 'confirmed');
const devKeypair = Keypair.fromSecretKey(
  DEV_PRIV.startsWith('[') ? Uint8Array.from(JSON.parse(DEV_PRIV)) :
  Uint8Array.from(Buffer.from(DEV_PRIV, 'base64'))
);
const devPubkey = new PublicKey(DEV_PUB);

// ---------- EXCHANGE FACTORY ----------
function makeExchange(): ExchangeAdapter {
  if (EXCHANGE === 'hyperliquid') {
    return new HyperliquidAdapter({ base: EX_API_BASE, apiKey: EX_API_KEY, apiSecret: EX_API_SECRET, subaccount: EX_SUBACCOUNT });
  }
  return new PaperExchange();
}
const exchange = makeExchange();

// ---------- REWARDS (naive) ----------
async function collectNewRewards() {
  const currentSlot = await connection.getSlot('confirmed');

  const lamports = await connection.getBalance(devPubkey, 'confirmed');

  const usdcAta = await getAssociatedTokenAddress(USDC_MINT, devPubkey, false);
  let usdcBal = 0;
  try {
    const usdcAcc = await connection.getTokenAccountBalance(usdcAta);
    usdcBal = Number(usdcAcc.value.amount) / Math.pow(10, usdcAcc.value.decimals);
  } catch { /* no ATA yet */ }

  return { currentSlot, lamports, usdcBal };
}

// ---------- JUPITER SWAP ----------
async function swapSolToUSDC(solAmount: number): Promise<number> {
  if (solAmount <= 0) return 0;

  const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${USDC_MINT.toBase58()}&amount=${Math.floor(solAmount * LAMPORTS_PER_SOL)}&slippageBps=50`;
  const quote = await (await fetch(quoteUrl)).json().catch(() => null);
  if (!quote?.data?.[0]) return 0;

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

  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([devKeypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  return Number(quote.data[0].outAmount) / 1_000_000;
}

// ---------- USDC TRANSFER ----------
async function transferUSDC(to: string, amount: number) {
  if (!to || amount <= 0) return;
  const toPub = new PublicKey(to);
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, devPubkey, false);
  const toAta = await getAssociatedTokenAddress(USDC_MINT, toPub, true);

  const { Transaction } = await import('@solana/web3.js');
  const tx = new Transaction();
  const decimals = 6;
  const raw = BigInt(Math.floor(amount * 10 ** decimals));
  tx.add(createTransferInstruction(fromAta, toAta, devPubkey, Number(raw), [], TOKEN_PROGRAM_ID));

  const sig = await connection.sendTransaction(tx, [devKeypair]);
  await connection.confirmTransaction(sig, 'confirmed');
}

// ---------- MAIN ----------
async function cycle() {
  const st = loadState();

  // 1) Rewards snapshot
  const rewards = await collectNewRewards();

  // 2) Convert SOL -> USDC (leave gas buffer)
  const sol = rewards.lamports / LAMPORTS_PER_SOL;
  let usdcFromSol = 0;
  if (sol > 0.02) {
    const solToUse = Math.max(0, sol - 0.02);
    usdcFromSol = await swapSolToUSDC(solToUse);
  }

  // 3) Total USDC
  const totalUSDC = rewards.usdcBal + usdcFromSol + st.carriedUSDC;

  // 4) Optionally move to exchange
  if (EX_DEPOSIT && totalUSDC >= MIN_REWARD_USDC) {
    await transferUSDC(EX_DEPOSIT, totalUSDC);
    st.carriedUSDC = 0;
    log(`Transferred ${totalUSDC.toFixed(2)} USDC to deposit address`);
  } else {
    st.carriedUSDC = totalUSDC;
    log(`Carried ${st.carriedUSDC.toFixed(2)} USDC (below MIN_REWARD_USDC or no deposit set)`);
  }

  // 5) Signal + trade
  const closes = await exchange.fetchCloses(SYMBOL, 300);
  const signal = makeSignal(closes);

  if (signal === 'LONG') {
    const r = await exchange.placePerpOrder({ symbol: SYMBOL, side: 'buy', leverage: LEVERAGE, notionalUSDC: TRADE_NOTIONAL_USDC, subaccount: EX_SUBACCOUNT });
    log('LONG order result:', r);
  } else if (signal === 'SHORT') {
    const r = await exchange.placePerpOrder({ symbol: SYMBOL, side: 'sell', leverage: LEVERAGE, notionalUSDC: TRADE_NOTIONAL_USDC, subaccount: EX_SUBACCOUNT });
    log('SHORT order result:', r);
  } else {
    warn('FLAT signal — no trade this cycle.');
  }

  // 6) Save state
  st.lastProcessedSlot = rewards.currentSlot;
  saveState(st);

  log(`Cycle complete: sol->usdc=${usdcFromSol.toFixed(2)} totalUSDC=${totalUSDC.toFixed(2)} signal=${signal}`);
}

(async () => {
  await cycle().catch(e => error(e));
  setInterval(() => cycle().catch(e => error(e)), RUN_INTERVAL_MIN * 60 * 1000);
})();
