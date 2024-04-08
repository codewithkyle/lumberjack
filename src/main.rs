use axum::{
    body::{Body, Bytes},
    http::{Request, StatusCode},
    routing::get,
    routing::post,
    Router,
    response::{IntoResponse, Response},
};
use tower_http::services::ServeFile;
use serde::Serialize;
use askama_axum::Template;
use std::env;
use rand::{distributions::Alphanumeric, thread_rng};
use rand::Rng;
use owo_colors::OwoColorize;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use anyhow::{Result, Error};
use std::io::Write;
use std::collections::HashMap;
use core::iter::Peekable;
use std::slice::Iter;
use uuid::Uuid;
use chrono::DateTime;

#[macro_use]
extern crate dotenv_codegen;

#[derive(Clone)]
struct Config {
    storage_path: Box<Path>,
    master_key: String,
}

fn generate_random_string(len: usize) -> String {
  let rng = thread_rng();
  let random_string: String = rng
      .sample_iter(&Alphanumeric)
      .take(len)
      .map(char::from)
      .collect();
  random_string
}

fn to_kebab_case(input: &str) -> String {
    let trimmed = input.trim();
    let kebab_case = trimmed.to_lowercase().replace(" ", "-");
    kebab_case
}

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{}", self.0),
        )
            .into_response()
    }
}

#[derive(Clone, Debug, Serialize)]
enum ErrorLevel {
    Emergency,
    Alert,
    Critical,
    Error,
    Warning,
    Notice,
    Info,
    Debug,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
struct Log {
    uid: String,
    level: ErrorLevel,
    file: String,
    function: String,
    line: u32,
    timestamp: String,
    message: String,
    custom: HashMap<String, String>,
    branch: String,
    env: String,
    category: String,
}

enum LogSection {
    Message,
    File,
    Function,
    Line,
    Custom,
    Branch,
    Category,
}

// This enables using `?` on functions that return `Result<_, anyhow::Error>` to turn them into
// `Result<_, AppError>`. That way you don't need to do that manually.
impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

#[tokio::main]
async fn main() {
    let ascii_name = r#"
888                             888                       d8b                   888      
888                             888                       Y8P                   888      
888                             888                                             888      
888      888  888 88888b.d88b.  888888b.   .d888b.  8d888 888  8888b.   .d8888b 888  888 
888      888  888 888 "888 "888 b88  "88b d8P  Y8b 888P"  888     "88b d88P"    888 .88P 
888      888  888 888  888  888 888   888 88888888 888    888 .d888888 888      888888K  
88888888 Y88b 888 888  888  888 888  d88P Y8b.     888    888 888  888 Y88b.    888 "88b 
88888888  "Y88888 888  888  888 888888P"   "Y8888  888    888 "Y888888  "Y8888P 888  888 
                                                          888                         
                                                         d88P                         
                                                        d88P
"#;
    println!("{}", ascii_name);

    let mut storage_path = dotenv!("STORAGE_PATH").to_string();
    if storage_path.is_empty() {
        storage_path = "./data".to_string();
    }

    let mut port = dotenv!("PORT").to_string();
    if port.is_empty() {
        port = "7777".to_string();
    }

    println!("Storage path:           \"{}\"", storage_path);
    println!("Package version:        \"{}\"", env!("CARGO_PKG_VERSION"));
    println!("Server listening on:    \"http://0.0.0.0:{}\"", port);

    println!("\nThank you for using Lumberjack!\n");

    let mut master_key = dotenv!("MASTER_KEY").to_string();
    if master_key.is_empty() {
        master_key = generate_random_string(128);
        println!("{}", " No MASTER_KEY found in .env file. \n".bold().black().on_yellow());
        println!("We generated a new secure master key for you (you can safely use this token):\n");
        println!(">> {} <<", master_key);
        println!("\nRestart Lumberjack with this key as the MASTER_KEY environment variable\n");
    }

    let storage_path = Path::new(&storage_path);
    if !storage_path.exists() {
        fs::create_dir_all(storage_path).unwrap_or_else(|_| {
            panic!("Failed to create storage directory at: {}", storage_path.display())
        });
    }

    let config = Arc::new(Config {
        storage_path: storage_path.into(),
        master_key: master_key.clone(),
    });

    let app = Router::new()
        .route("/", get(root))
        .route("/logs", post(move |req| write_logs(req, config.clone())))
        .route_service("/static/main.js", ServeFile::new("static/main.js"))
        .route_service("/static/main.css", ServeFile::new("static/main.css"));

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> RootTemplate {
    RootTemplate { }
}

#[derive(Template)]
#[template(path = "root.twig.html")]
struct RootTemplate {
}

async fn write_logs(req: Request<Body>, config: Arc<Config>) -> Result<(), AppError> {
    let app = req.headers().get("Lumberjack-App");
    let env = req.headers().get("Lumberjack-Env");
    let key = req.headers().get("Authorization");

    if key.is_none() {
        return Err(AppError(anyhow::anyhow!("Authorization header is required")));
    }

    if app.is_none() || env.is_none(){
        return Err(AppError(anyhow::anyhow!("Lumberjack-App and Lumberjack-Env headers are required")));
    }

    let key = key.unwrap().to_str().unwrap();
    let app = to_kebab_case(app.unwrap().to_str().unwrap());
    let env = env.unwrap().to_str().unwrap().to_string();

    if key != config.master_key {
        return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
    }

    let body = axum::body::to_bytes(req.into_body(), std::usize::MAX).await?;
    if body.is_empty() {
        return Err(AppError(anyhow::anyhow!("Body is empty")));
    }

    let app_path = config.storage_path.join(app);
    if !app_path.exists() {
        fs::create_dir_all(&app_path)?;
    }

    let mut logs: Vec<Log> = Vec::new();
    let string_body = String::from_utf8(body.to_vec())?;
    let mut building_log = false;
    let mut lines: Vec<String> = Vec::new();
    for line in string_body.lines() {
        if building_log {
            match line {
                "---[EOL]---" => {
                    building_log = false;
                    let mut new_log = create_log(&lines);
                    new_log.env = env.clone();
                    logs.push(new_log);
                    lines.clear();
                }
                _ => {
                    lines.push(line.to_string());
                }
            }
        } else {
            building_log = true;
            lines.push(line.to_string());
        }
    }
    
    write_log_files(logs, app_path)?;

    Ok(())
}

fn write_log_files(logs: Vec<Log>, app_path: PathBuf) -> Result<(), Error> {
    let daily_ledger_path = app_path.clone().join("ledgers");
    if !daily_ledger_path.exists() {
        fs::create_dir_all(&daily_ledger_path)?;
    }

    for log in logs {
        let log_date = DateTime::parse_from_rfc3339(log.timestamp.as_str())?.format("%Y-%m-%d").to_string();

        let daily_log_path = app_path.clone().join("search").join(log_date.clone());
        if !daily_log_path.exists() {
            fs::create_dir_all(&daily_log_path)?;
        }
        
        let ledger = daily_ledger_path.join(format!("{}.jsonl", log_date));
        let mut ledger = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&ledger)?;

        let log_json = serde_json::to_string(&log)?;
        ledger.write_all(log_json.as_bytes())?;
        ledger.write_all("\n".as_bytes())?;

        let message_cache = daily_log_path.join(format!("{}", log.uid));
        let mut message_cache = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&message_cache)?;
        message_cache.write_all(log.message.as_bytes())?;
    }

    Ok(())
}

fn create_log(lines: &Vec<String>) -> Log {
    let mut lines = lines.iter().peekable();
    let mut new_log: Log = Log {
        uid: Uuid::now_v7().to_string(),
        level: ErrorLevel::Unknown,
        file: "".to_string(),
        function: "".to_string(),
        line: 0,
        timestamp: "".to_string(),
        message: "".to_string(),
        custom: HashMap::new(),
        branch: "".to_string(),
        env: "".to_string(),
        category: "".to_string(),
    };

    let first_line = lines.next().unwrap();
    let mut first_line_parts = first_line.split_whitespace();
    let level = first_line_parts.next().unwrap();
    match level.to_uppercase().trim() {
        "[EMERGENCY]" => new_log.level = ErrorLevel::Emergency,
        "[ALERT]" => new_log.level = ErrorLevel::Alert,
        "[CRITICAL]" => new_log.level = ErrorLevel::Critical,
        "[ERROR]" => new_log.level = ErrorLevel::Error,
        "[WARNING]" => new_log.level = ErrorLevel::Warning,
        "[NOTICE]" => new_log.level = ErrorLevel::Notice,
        "[INFORMATIONAL]" => new_log.level = ErrorLevel::Info,
        "[DEBUG]" => new_log.level = ErrorLevel::Debug,
        _ => new_log.level = ErrorLevel::Unknown,
    }
    new_log.timestamp = first_line_parts.skip(1).next().unwrap_or("").to_string();

    loop {
        let binding = String::from("---[EOL]---");
        let line = lines.next().unwrap_or(&binding);

        let mut result = String::new();
        let mut section = LogSection::Message;
        let mut line_parts = line.split(":");
        match line_parts.nth(0).unwrap_or("").trim().to_uppercase().as_str() {
            "MESSAGE" => {
                section = LogSection::Message;
                result = parse_log_message(&mut lines);
            }
            "FILE" => {
                section = LogSection::File;
                result = line_parts.collect();
            }
            "FUNCTION" => {
                section = LogSection::Function;
                result = line_parts.collect();
            }
            "LINE" => {
                section = LogSection::Line;
                result = line_parts.collect();
            }
            "CATEGORY" => {
                section = LogSection::Category;
                result = line_parts.collect();
            }
            "BRANCH" => {
                section = LogSection::Branch;
                result = line_parts.collect();
            }
            "---[EOL]---" => break,
            _ => {
                section = LogSection::Custom;
                result = line.clone();
            }
        }
        match section {
            LogSection::Message => new_log.message = result.trim().to_string(),
            LogSection::File => new_log.file = result.trim().to_string(),
            LogSection::Function => new_log.function = result.trim().to_string(),
            LogSection::Line => new_log.line = result.trim().parse().unwrap_or(0),
            LogSection::Category => new_log.category = result.trim().to_string(),
            LogSection::Branch => new_log.branch = result.trim().to_string(),
            LogSection::Custom => {
                let mut parts = result.split(":");
                let key = parts.next().unwrap_or("").trim().to_string();
                let value = parts.next().unwrap_or("").trim().to_string();
                new_log.custom.insert(key, value);
            }
        }
    }

    return new_log;
}

fn parse_log_message(lines: &mut Peekable<Iter<'_, String>>) -> String {
    let mut result = String::new();

    loop {
        match lines.peek().unwrap_or(&&String::from("---[EOL]---")).trim().to_uppercase().as_str() {
            "---[EOL]---" => break,
            _ => {
                let line = lines.next().unwrap();
                result = result + "\n" + line.trim();
            }
        };
    }

    return result.trim().to_string();
}
