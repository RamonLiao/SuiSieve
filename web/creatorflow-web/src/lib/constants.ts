export const NETWORK = "testnet" as const;
export const PACKAGE_ID =
  "0x0fda0d5bd9f042460d8ed51eaeaf2fd21e9d4baa74de75b031096516e047a656";
export const PROTOCOL_CONFIG_ID =
  "0x695297e727cd5fa636deff6578b3e5f53aa496ecd323248c1d072b58d9891bcc";
export const USDC_TYPE =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
export const CLOCK_ID = "0x6";
export const MAX_RECIPIENTS = 16;
export const BPS_TOTAL = 10_000;
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
