const RULES: Array<[RegExp, string]> = [
  [/EConfigChanged/, "Config changed since you loaded it — refresh and retry."],
  [/EVaultMismatch/, "Vault/config mismatch — wrong vault for this config."],
  [/EZeroPayment/, "Amount must be greater than 0."],
  [/EWrongCap|ETreasury|cap/i, "You are not authorized (missing capability)."],
];

export function mapAbort(rawError: string | null | undefined): string {
  if (!rawError) return "Transaction failed.";
  for (const [re, msg] of RULES) if (re.test(rawError)) return msg;
  return rawError.trim();
}
