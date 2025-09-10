export type Side = 'buy' | 'sell';

export interface ExchangeAdapter {
  /** Returns most-recent hourly closes for SYMBOL. */
  fetchCloses(symbol: string, limit?: number): Promise<number[]>;
  /** Places a market order using notional USDC @ leverage (20x, etc). */
  placePerpOrder(params: {
    symbol: string;
    side: Side;
    leverage: number;
    notionalUSDC: number;
    subaccount?: string;
  }): Promise<any>;
  /** Optional funding / balances as needed later */
}
