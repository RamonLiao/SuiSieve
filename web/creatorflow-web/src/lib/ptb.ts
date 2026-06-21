import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { CLOCK_ID, MOCK_MARKET_ID, PACKAGE_ID, PROTOCOL_CONFIG_ID } from "./constants";
import type { RecipientInput } from "./bps";

const R = `${PACKAGE_ID}::router`;
const SC = `${PACKAGE_ID}::split_config`;

function recipientVec(tx: Transaction, recipients: RecipientInput[]) {
  const items = recipients.map((r) =>
    tx.moveCall({
      target: `${SC}::new_recipient`,
      arguments: [
        tx.pure.address(r.addr),
        tx.pure.u16(r.bps),
        tx.pure(
          bcs
            .vector(bcs.u8())
            .serialize(Array.from(new TextEncoder().encode(r.label))),
        ),
      ],
    }),
  );
  return tx.makeMoveVec({ type: `${SC}::Recipient`, elements: items });
}

export function buildCreateConfig(d: {
  recipients: RecipientInput[];
  taxBps: number;
  savingsBps: number;
  feeBps: number;
  yieldBps: number;
}): Transaction {
  const tx = new Transaction();
  const recipients = recipientVec(tx, d.recipients);
  const noneStrategy = tx.moveCall({
    target: "0x1::option::none",
    typeArguments: [`${SC}::StrategyRef`],
    arguments: [],
  });
  tx.moveCall({
    target: `${R}::create_config_and_vaults`,
    arguments: [
      tx.object(PROTOCOL_CONFIG_ID),
      recipients,
      tx.pure.u16(d.taxBps),
      tx.pure.u16(d.savingsBps),
      tx.pure.u16(d.feeBps),
      tx.pure.u16(d.yieldBps),
      noneStrategy,
    ],
  });
  return tx;
}

export function buildExecuteSplit(p: {
  configId: string;
  taxVaultId: string;
  savingsVaultId: string;
  amountIn: bigint;
  expectedVersion: bigint;
  usdcCoinIds: string[];
}): Transaction {
  const tx = new Transaction();
  const [primary, ...rest] = p.usdcCoinIds;
  const primaryCoin = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryCoin, rest.map((id) => tx.object(id)));
  }
  const [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(p.amountIn)]);
  tx.moveCall({
    target: `${R}::execute_split`,
    arguments: [
      tx.object(p.configId),
      tx.object(PROTOCOL_CONFIG_ID),
      tx.object(p.taxVaultId),
      tx.object(p.savingsVaultId),
      payment,
      tx.pure.bool(false),
      tx.pure.u64(p.expectedVersion),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export function buildMutateConfig(p: {
  configId: string;
  ownerCapId: string;
  recipients: RecipientInput[];
  taxBps: number;
  savingsBps: number;
}): Transaction {
  const tx = new Transaction();
  const recipients = recipientVec(tx, p.recipients);
  tx.moveCall({
    target: `${R}::mutate_config`,
    arguments: [
      tx.object(p.configId),
      tx.object(p.ownerCapId),
      tx.object(PROTOCOL_CONFIG_ID),
      recipients,
      tx.pure.u16(p.taxBps),
      tx.pure.u16(p.savingsBps),
    ],
  });
  return tx;
}

export function buildWithdraw(p: {
  vaultId: string;
  capId: string;
  amount: bigint;
  kind: "tax" | "savings";
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${R}::withdraw_${p.kind}`,
    arguments: [tx.object(p.vaultId), tx.object(p.capId), tx.pure.u64(p.amount)],
  });
  return tx;
}

export function buildExecuteSplitWithYield(p: {
  configId: string;
  taxVaultId: string;
  savingsVaultId: string;
  amountIn: bigint;
  expectedVersion: bigint;
  usdcCoinIds: string[];
}): Transaction {
  const tx = new Transaction();
  const [primary, ...rest] = p.usdcCoinIds;
  const primaryCoin = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryCoin, rest.map((id) => tx.object(id)));
  }
  const [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(p.amountIn)]);
  tx.moveCall({
    target: `${R}::execute_split_with_yield`,
    arguments: [
      tx.object(p.configId),
      tx.object(PROTOCOL_CONFIG_ID),
      tx.object(MOCK_MARKET_ID),
      tx.object(p.taxVaultId),
      tx.object(p.savingsVaultId),
      payment,
      tx.pure.u64(p.expectedVersion),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export function buildRedeemYield(p: {
  savingsVaultId: string;
  savingsCapId: string;
  amount: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${R}::redeem_yield`,
    arguments: [
      tx.object(MOCK_MARKET_ID),
      tx.object(p.savingsVaultId),
      tx.object(p.savingsCapId),
      tx.pure.u64(p.amount),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}
