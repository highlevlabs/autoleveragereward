import fs from 'fs';

export type State = { lastProcessedSlot: number; carriedUSDC: number };

const STATE_FILE = './state.json';

export function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastProcessedSlot: 0, carriedUSDC: 0 }; }
}

export function saveState(s: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
