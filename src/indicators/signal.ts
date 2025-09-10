import { RSI, EMA } from 'technicalindicators';

export type Signal = 'LONG' | 'SHORT' | 'FLAT';

export function makeSignal(closes: number[]): Signal {
  if (closes.length < 100) return 'FLAT';

  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema55 = EMA.calculate({ period: 55, values: closes });

  const rsi = rsiArr.at(-1)!;
  const fast = ema21.at(-1)!;
  const slow = ema55.at(-1)!;

  if (fast > slow && rsi >= 52) return 'LONG';
  if (fast < slow && rsi <= 48) return 'SHORT';
  return 'FLAT';
}
