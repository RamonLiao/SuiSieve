use std::str::FromStr;

use clap::Parser;
use creatorflow_indexer::handler::CreatorflowHandler;
use creatorflow_indexer::MIGRATIONS;
use sui_indexer_alt_framework::cluster::{Args, IndexerCluster};
use sui_indexer_alt_framework::pipeline::sequential::SequentialConfig;
use sui_indexer_alt_framework::types::base_types::ObjectID;
use url::Url;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    // Framework CLI/env supplies the checkpoint source (--remote-store-url /
    // --rpc-api-url), checkpoint range, and metrics address.
    let args = Args::parse();

    let database_url = Url::parse(&std::env::var("DATABASE_URL")?)?;
    let package = ObjectID::from_str(&std::env::var("CREATORFLOW_PKG")?)?;

    let mut cluster = IndexerCluster::builder()
        .with_args(args)
        .with_database_url(database_url)
        .with_migrations(&MIGRATIONS)
        .build()
        .await?;

    // Single sequential pipeline → one watermark, per-checkpoint atomic commit
    // across all 5 tables.
    cluster
        .sequential_pipeline(CreatorflowHandler { package }, SequentialConfig::default())
        .await?;

    let mut service = cluster.run().await?;
    service.join().await?;
    Ok(())
}
