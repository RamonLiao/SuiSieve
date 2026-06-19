import { BPS_TOTAL, MAX_RECIPIENTS } from "./constants";

export type RecipientInput = { addr: string; bps: number; label: string };
export type SplitDraft = {
  recipients: RecipientInput[];
  taxBps: number; savingsBps: number; feeBps: number; yieldBps: number;
};
type Result = { ok: true } | { ok: false; error: string };

const U16_MAX = 65_535;
const isU16 = (n: number) => Number.isInteger(n) && n >= 0 && n <= U16_MAX;

export function validateSplit(d: SplitDraft): Result {
  if (d.recipients.length > MAX_RECIPIENTS)
    return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients` };
  for (const r of d.recipients) {
    if (!/^0x[0-9a-f]{64}$/.test(r.addr))
      return { ok: false, error: `Invalid address: ${r.addr}` };
    if (!isU16(r.bps) || r.bps === 0)
      return { ok: false, error: `Each recipient bps must be 1..${U16_MAX}` };
  }
  for (const [k, v] of Object.entries({ taxBps: d.taxBps, savingsBps: d.savingsBps, feeBps: d.feeBps, yieldBps: d.yieldBps }))
    if (!isU16(v)) return { ok: false, error: `${k} must be 0..${U16_MAX}` };
  if (d.yieldBps > d.savingsBps)
    return { ok: false, error: "yield bps cannot exceed savings bps" };
  const sum = d.recipients.reduce((a, r) => a + r.bps, 0) + d.taxBps + d.savingsBps + d.feeBps;
  if (sum !== BPS_TOTAL)
    return { ok: false, error: `bps must sum to ${BPS_TOTAL} (got ${sum})` };
  return { ok: true };
}
