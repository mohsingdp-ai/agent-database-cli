mod adapters;
mod config;
mod daemon;
mod output;
mod runtime;
mod security;
mod ssh_tunnel;
mod types;
mod utils;

use anyhow::Result;
use clap::{Parser, Subcommand};
use types::{MetadataRequest, MetadataType, OutputFormat};

#[derive(Parser)]
#[command(name = "agent-database-cli", version, about = "统一数据库命令行工具")]
struct Cli {
    #[arg(long, default_value = "json", value_parser = ["json", "table"])]
    format: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "展示支持的数据库类型")]
    List,
    #[command(about = "测试数据库连接")]
    Test {
        #[arg(long)]
        db: String,
    },
    #[command(name = "exec", about = "统一执行 SQL、Redis 命令或 MongoDB JSON 命令")]
    Execute {
        #[arg(long)]
        db: String,
        #[arg(long)]
        command: String,
    },
    #[command(name = "meta", about = "查询数据库元信息")]
    Metadata {
        #[arg(long)]
        db: String,
        #[arg(long = "type", value_parser = ["tables", "columns", "collections", "keys"])]
        metadata_type: String,
        #[arg(long)]
        table: Option<String>,
        #[arg(long)]
        pattern: Option<String>,
    },
    #[command(about = "重置指定数据库连接")]
    Reset {
        #[arg(long)]
        db: String,
    },
    #[command(about = "管理本地连接守护进程")]
    Daemon {
        #[command(subcommand)]
        command: DaemonCommands,
    },
}

#[derive(Subcommand)]
enum DaemonCommands {
    #[command(about = "启动 daemon")]
    Start,
    #[command(about = "停止 daemon")]
    Stop,
    #[command(about = "查看 daemon 状态")]
    Status,
    #[command(hide = true)]
    Run,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}", utils::masking::to_error_message(&error));
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let format = parse_output_format(&cli.format)?;
    let data = match cli.command {
        Commands::List => runtime::run_list().await?,
        Commands::Test { db } => runtime::run_test(&db).await?,
        Commands::Execute { db, command } => {
            serde_json::to_value(runtime::run_execute(&db, &command).await?)?
        }
        Commands::Metadata {
            db,
            metadata_type,
            table,
            pattern,
        } => {
            let request = MetadataRequest {
                request_type: parse_metadata_type(&metadata_type)?,
                table,
                pattern,
            };
            serde_json::to_value(runtime::run_metadata(&db, request).await?)?
        }
        Commands::Reset { db } => runtime::run_reset(&db).await?,
        Commands::Daemon { command } => match command {
            DaemonCommands::Start => daemon::control::start_daemon().await?,
            DaemonCommands::Stop => daemon::control::stop_daemon().await?,
            DaemonCommands::Status => daemon::control::daemon_status().await?,
            DaemonCommands::Run => {
                daemon::server::run_server().await?;
                serde_json::json!({ "stopped": true })
            }
        },
    };
    output::write_output(&data, format)?;
    Ok(())
}

fn parse_output_format(value: &str) -> Result<OutputFormat> {
    match value {
        "json" => Ok(OutputFormat::Json),
        "table" => Ok(OutputFormat::Table),
        other => anyhow::bail!("不支持的输出格式: {other}"),
    }
}

fn parse_metadata_type(value: &str) -> Result<MetadataType> {
    match value {
        "tables" => Ok(MetadataType::Tables),
        "columns" => Ok(MetadataType::Columns),
        "collections" => Ok(MetadataType::Collections),
        "keys" => Ok(MetadataType::Keys),
        other => anyhow::bail!("不支持的元信息类型: {other}"),
    }
}
