CREATE TABLE config_created (
  config_id        TEXT PRIMARY KEY,
  tx_digest        TEXT NOT NULL,
  tax_vault_id     TEXT NOT NULL,
  savings_vault_id TEXT NOT NULL,
  owner            TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL
);
CREATE INDEX config_created_owner_idx ON config_created (owner);

CREATE TABLE split_executed (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  config_id TEXT NOT NULL,
  config_version BIGINT NOT NULL,
  amount_in BIGINT NOT NULL,
  tax_amount BIGINT NOT NULL,
  savings_amount BIGINT NOT NULL,
  protocol_fee_amount BIGINT NOT NULL,
  yield_amount BIGINT NOT NULL,
  yield_included BOOLEAN NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  checkpoint BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);
CREATE INDEX split_executed_config_ts_idx ON split_executed (config_id, timestamp_ms DESC);

CREATE TABLE recipient_payout (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  payout_idx INT NOT NULL,
  recipient TEXT NOT NULL,
  amount BIGINT NOT NULL,
  bps INT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq, payout_idx),
  FOREIGN KEY (tx_digest, event_seq) REFERENCES split_executed (tx_digest, event_seq)
);
CREATE INDEX recipient_payout_recipient_idx ON recipient_payout (recipient);

CREATE TABLE config_mutated (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  config_id TEXT NOT NULL,
  old_version BIGINT NOT NULL,
  new_version BIGINT NOT NULL,
  mutator TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);

CREATE TABLE vault_withdrawn (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  vault_id TEXT NOT NULL,
  kind SMALLINT NOT NULL,
  amount BIGINT NOT NULL,
  recipient TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);
