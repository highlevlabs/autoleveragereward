import { ExchangeAdapter, Side } from './exchange.js';

export class PaperExchange implements ExchangeAdapter {
  async fetchCloses(_symbol: string, limit = 200): Promise<number[]> {
    // Fake a gently trending series; replace with a real feed when ready.
    const now = Date.now();
    const arr: number[] = [];
    let p = 60000; // seed price
    for (let i = limit; i > 0; i--) {
      p += Math.sin((now / 3.6e6 + i) * 0.7) * 40 + (Math.random() - 0.5) * 35;
      arr.push(Math.max(1000, p));
    }
    return arr;
  }

  async placePerpOrder(params: {
    symbol: string; side: Side; leverage: number; notionalUSDC: number; subaccount?: string;
  }): Promise<any> {
    // Paper trade: just log and succeed
    return {
      status: 'ok',
      simulated: true,
      ...params,
      fillPrice: 60000 + (Math.random() - 0.5) * 50,
      ts: Date.now()
    };
  }
}
