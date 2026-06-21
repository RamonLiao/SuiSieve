export const NETWORK = "testnet" as const;
export const PACKAGE_ID =
  "0xe16643b188985330b377f01681223a95dae2256515c7a9f7c0b610ab03739381";
export const PROTOCOL_CONFIG_ID =
  "0x979f40b1b0ba55296e8842c3a627fcca2822311487ac32ef15677a69cce3ac5d";
export const USDC_TYPE =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
export const CLOCK_ID = "0x6";
// Shared MockMarket created via mock_lending::create_market(&AdminCap) one-shot
// (Task 7 fresh-deploy 2026-06-22, tx CRNwZq1N…). interest_buffer seeded 5 USDC.
export const MOCK_MARKET_ID =
  "0x9a1ad8a046c9365b00d77ed8ca6bbc76a73996291b26ed1b38f41347e32f18a9";
export const MAX_RECIPIENTS = 16;
export const BPS_TOTAL = 10_000;
// On-chain protocol fee window. These mirror the deployed ProtocolConfig
// (min_fee_bps/max_fee_bps). They are admin-mutable on-chain within
// [0, MAX_FEE_CEILING=1000], so the proper hardening is to read them from
// ProtocolConfig at form load and pass them into validateSplit. Until then
// these defaults match the deployed values and keep the client fail-loud.
export const MIN_FEE_BPS = 30;
export const MAX_FEE_BPS = 100;
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
