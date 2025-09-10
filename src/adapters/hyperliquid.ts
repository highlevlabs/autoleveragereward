import fetch from 'node-fetch';
import { ExchangeAdapter, Side } from './exchange.js';

type Cfg = {
  base: string;
  apiKey?: string;
  apiSecret?: string;
  subaccount?: string;
};

export class HyperliquidAdapter implements ExchangeAdapter {
  constructor(private cfg: Cfg) {}

  async fetchCloses(symbol: string, limit = 200): Promise<number[]> {
    // Replace with the correct public endpoint and shape for klines.
    const url = `${this.cfg.base}/market/klines?symbol=${encodeURIComponent(symbol)}&interval=60m&limit=${limit}`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json();
    return data.map((k: any) => Number(k.close)).filter((n: number) => Number.isFinite(n));
  }

  async placePerpOrder(params: {
    symbol: string; side: Side; leverage: number; notionalUSDC: number; subaccount?: string;
  }): Promise<any> {
    // Replace with the actual authenticated order endpoint + signature/HMAC headers.
    const body = {
      symbol: params.symbol,
      side: params.side,
      leverage: params.leverage,
      type: 'market',
      notional: params.notionalUSDC,
      subaccount: params.subaccount || this.cfg.subaccount || 'default',
      tif: 'ioc'
    };

    const res = await fetch(`${this.cfg.base}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.cfg.apiKey || ''
        // Add auth signature headers here as required by Hyperliquid
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Order failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
