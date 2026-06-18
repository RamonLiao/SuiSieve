pub mod events;
pub mod handler;
pub mod models;
pub mod schema;

use diesel_migrations::{embed_migrations, EmbeddedMigrations};

/// The 5-table CreatorFlow schema, embedded so the indexer applies it on
/// startup. The framework runs its own watermark migrations alongside these.
pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");
