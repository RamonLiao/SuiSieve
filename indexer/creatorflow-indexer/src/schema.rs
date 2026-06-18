// @generated equivalent — hand-written to mirror migrations/.../up.sql exactly.
// Column SQL→diesel type map: TEXT→Text, BIGINT→Int8, INT→Int4, SMALLINT→Int2, BOOLEAN→Bool.
// If a DB is reachable, `diesel print-schema > src/schema.rs` regenerates this verbatim.

diesel::table! {
    config_created (config_id) {
        config_id -> Text,
        tx_digest -> Text,
        tax_vault_id -> Text,
        savings_vault_id -> Text,
        owner -> Text,
        checkpoint_timestamp_ms -> Int8,
    }
}

diesel::table! {
    split_executed (tx_digest, event_seq) {
        tx_digest -> Text,
        event_seq -> Int8,
        config_id -> Text,
        config_version -> Int8,
        amount_in -> Int8,
        tax_amount -> Int8,
        savings_amount -> Int8,
        protocol_fee_amount -> Int8,
        yield_amount -> Int8,
        yield_included -> Bool,
        timestamp_ms -> Int8,
        checkpoint -> Int8,
    }
}

diesel::table! {
    recipient_payout (tx_digest, event_seq, payout_idx) {
        tx_digest -> Text,
        event_seq -> Int8,
        payout_idx -> Int4,
        recipient -> Text,
        amount -> Int8,
        bps -> Int4,
    }
}

diesel::table! {
    config_mutated (tx_digest, event_seq) {
        tx_digest -> Text,
        event_seq -> Int8,
        config_id -> Text,
        old_version -> Int8,
        new_version -> Int8,
        mutator -> Text,
        checkpoint_timestamp_ms -> Int8,
    }
}

diesel::table! {
    vault_withdrawn (tx_digest, event_seq) {
        tx_digest -> Text,
        event_seq -> Int8,
        vault_id -> Text,
        kind -> Int2,
        amount -> Int8,
        recipient -> Text,
        checkpoint_timestamp_ms -> Int8,
    }
}

diesel::allow_tables_to_appear_in_same_query!(
    config_created,
    split_executed,
    recipient_payout,
    config_mutated,
    vault_withdrawn,
);
