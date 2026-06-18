import { Pool } from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgres://creatorflow:creatorflow@localhost:5433/creatorflow_indexer";

export const testPool = new Pool({ connectionString: url });

export async function truncateAll(): Promise<void> {
  await testPool.query(
    `TRUNCATE config_created, split_executed, recipient_payout, config_mutated, vault_withdrawn RESTART IDENTITY CASCADE`,
  );
}

export async function seedConfig(r: {
  configId: string;
  txDigest: string;
  taxVaultId: string;
  savingsVaultId: string;
  owner: string;
  ts: bigint;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO config_created (config_id, tx_digest, tax_vault_id, savings_vault_id, owner, checkpoint_timestamp_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.configId, r.txDigest, r.taxVaultId, r.savingsVaultId, r.owner, r.ts.toString()],
  );
}

export async function seedSplit(r: {
  txDigest: string;
  eventSeq: bigint;
  configId: string;
  configVersion: bigint;
  amountIn: bigint;
  taxAmount: bigint;
  savingsAmount: bigint;
  protocolFeeAmount: bigint;
  yieldAmount: bigint;
  yieldIncluded: boolean;
  timestampMs: bigint;
  checkpoint: bigint;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO split_executed
       (tx_digest, event_seq, config_id, config_version, amount_in, tax_amount, savings_amount,
        protocol_fee_amount, yield_amount, yield_included, timestamp_ms, checkpoint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      r.txDigest,
      r.eventSeq.toString(),
      r.configId,
      r.configVersion.toString(),
      r.amountIn.toString(),
      r.taxAmount.toString(),
      r.savingsAmount.toString(),
      r.protocolFeeAmount.toString(),
      r.yieldAmount.toString(),
      r.yieldIncluded,
      r.timestampMs.toString(),
      r.checkpoint.toString(),
    ],
  );
}

export async function seedPayout(r: {
  txDigest: string;
  eventSeq: bigint;
  payoutIdx: number;
  recipient: string;
  amount: bigint;
  bps: number;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO recipient_payout (tx_digest, event_seq, payout_idx, recipient, amount, bps)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.txDigest, r.eventSeq.toString(), r.payoutIdx, r.recipient, r.amount.toString(), r.bps],
  );
}

export async function seedMutation(r: {
  txDigest: string;
  eventSeq: bigint;
  configId: string;
  oldVersion: bigint;
  newVersion: bigint;
  mutator: string;
  ts: bigint;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO config_mutated
       (tx_digest, event_seq, config_id, old_version, new_version, mutator, checkpoint_timestamp_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      r.txDigest,
      r.eventSeq.toString(),
      r.configId,
      r.oldVersion.toString(),
      r.newVersion.toString(),
      r.mutator,
      r.ts.toString(),
    ],
  );
}

export async function seedWithdrawal(r: {
  txDigest: string;
  eventSeq: bigint;
  vaultId: string;
  kind: number;
  amount: bigint;
  recipient: string;
  ts: bigint;
}): Promise<void> {
  await testPool.query(
    `INSERT INTO vault_withdrawn
       (tx_digest, event_seq, vault_id, kind, amount, recipient, checkpoint_timestamp_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      r.txDigest,
      r.eventSeq.toString(),
      r.vaultId,
      r.kind,
      r.amount.toString(),
      r.recipient,
      r.ts.toString(),
    ],
  );
}
