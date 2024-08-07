use anyhow::{Error, Result};
use askama_axum::Template;
use axum::{
    body::Body,
    extract::Path as PathExtractor,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use axum_macros::debug_handler;
use chrono::DateTime;
use core::iter::Peekable;
use lazy_static::lazy_static;
use owo_colors::OwoColorize;
use rand::Rng;
use rand::{distributions::Alphanumeric, thread_rng};
use serde::Serialize;
use std::fs;
use std::fs::read_dir;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::slice::Iter;
use std::sync::Mutex;
use std::{
    collections::HashMap,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom},
};
use std::{
    env,
    fmt::{self, Display},
};
use tokio::process::Command;
use tower_http::services::ServeFile;
use uuid::Uuid;

#[macro_use]
extern crate dotenv_codegen;

static VERSION: u32 = 1;

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

#[derive(Clone, Debug, Serialize)]
enum Rentention {
    DELETE,
    ARCHIVE,
}

impl Display for Rentention {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match *self {
            Rentention::DELETE => write!(f, "DELETE"),
            Rentention::ARCHIVE => write!(f, "ARCHIVE"),
        }
    }
}

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("{}", self.0)).into_response()
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
    line: Option<u32>,
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

lazy_static! {
    static ref CONFIG: Mutex<HashMap<String, String>> = Mutex::new({
        let mut m = HashMap::new();
        m.insert(
            "storage_path".to_string(),
            dotenv!("STORAGE_PATH").to_string(),
        );
        m.insert("master_key".to_string(), dotenv!("MASTER_KEY").to_string());
        m.insert("port".to_string(), dotenv!("PORT").to_string());
        m.insert(
            "mode".to_string(),
            dotenv!("MODE").to_string().to_lowercase(),
        );
        m.insert(
            "days_retained".to_string(),
            dotenv!("DAYS_RETAINED").to_string(),
        );
        m
    });
    static ref KEYS: Mutex<HashMap<String, Vec<String>>> = Mutex::new({
        let m = HashMap::new();
        m
    });
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

    let mut port = "7777".to_string();
    {
        let mut config = CONFIG.lock().unwrap();
        let mut keychain = KEYS.lock().unwrap();

        if config.get("storage_path").unwrap().is_empty() {
            config.insert("storage_path".to_string(), "./data".to_string());
        }

        port = config.get("port").unwrap().to_string();
        if port.is_empty() {
            config.insert("port".to_string(), "7777".to_string());
            port = "7777".to_string();
        }

        let mode = match config.get("mode").unwrap().as_str() {
            "delete" => Rentention::DELETE.to_string(),
            "archive" => Rentention::ARCHIVE.to_string(),
            _ => Rentention::DELETE.to_string(),
        };
        config.insert("mode".to_string(), mode);

        let days_retained = config
            .get("days_retained")
            .unwrap()
            .parse::<u32>()
            .unwrap_or(14);
        config.insert("days_retained".to_string(), days_retained.to_string());

        println!(
            "Storage path:           \"{}\"",
            config.get("storage_path").unwrap()
        );
        println!("Package version:        \"{}\"", env!("CARGO_PKG_VERSION"));
        println!(
            "Server listening on:    \"http://0.0.0.0:{}\"",
            config.get("port").unwrap()
        );
        println!(
            "Rentention:             \"{} days\"",
            config.get("days_retained").unwrap()
        );
        println!(
            "Mode:                   \"{}\"",
            config.get("mode").unwrap()
        );

        println!("\nThank you for using Lumberjack!\n");

        if config.get("master_key").unwrap().is_empty() {
            config.insert("master_key".to_string(), generate_random_string(128));
            println!(
                "{}",
                " No MASTER_KEY found in .env file. \n"
                    .bold()
                    .black()
                    .on_yellow()
            );
            println!(
                "We generated a new secure master key for you (you can safely use this token):\n"
            );
            println!(">> {} <<", config.get("master_key").unwrap());
            println!("\nRestart Lumberjack with this key as the MASTER_KEY environment variable\n");
        }

        let storage_path = Path::new(config.get("storage_path").unwrap());
        if !storage_path.exists() {
            fs::create_dir_all(storage_path).unwrap_or_else(|_| {
                panic!(
                    "Failed to create storage directory at: {}",
                    storage_path.display()
                )
            });
        }

        for path in fs::read_dir(&storage_path).unwrap() {
            let path = path.unwrap().path();
            let app = path.to_str().unwrap().rsplit_once("/").unwrap().1;
            let keychain_path = path.join("keychain");

            if keychain_path.exists() {
                let file = fs::OpenOptions::new()
                    .read(true)
                    .open(&keychain_path)
                    .unwrap();
                let mut reader = BufReader::new(&file);

                let mut version_buffer = [0u8; 4];
                reader.read_exact(&mut version_buffer).unwrap();
                let _version: u32 = u32::from_be_bytes(version_buffer);

                let mut key_count_buffer = [0u8; 4];
                reader.read_exact(&mut key_count_buffer).unwrap();
                let key_count: u32 = u32::from_be_bytes(key_count_buffer);

                let mut keys: Vec<String> = Vec::with_capacity(key_count.try_into().unwrap());

                let mut i = 0;
                loop {
                    let mut is_active_buffer = [0u8; 1];
                    reader.read_exact(&mut is_active_buffer).unwrap();
                    let is_active = u8::from_be_bytes(is_active_buffer) == 1;
                    if is_active {
                        let mut key_buffer = [0u8; 64];
                        reader.read_exact(&mut key_buffer).unwrap();
                        let key = std::str::from_utf8(&key_buffer).unwrap();
                        keys.push(key.to_string());
                        i += 1;
                        if i == key_count {
                            break;
                        }
                    } else {
                        reader.seek(SeekFrom::Current(64)).unwrap();
                    }
                }

                keychain.insert(app.to_string(), keys);
            }
        }
    }

    let app = Router::new()
        .route("/", get(root))
        .route("/logs", post(write_logs))
        .route("/logs/:app/:file", get(stream_log))
        .route("/search/:app/:file", post(search_logs))
        .route("/size/:app/:file", get(log_size))
        .route("/admin/keys", get(list_keys))
        .route("/admin/keys", post(create_key))
        .route("/admin/keys", delete(delete_key))
        .route("/admin/cleanup", post(cleanup_logs))
        .route_service("/static/main.js", ServeFile::new("static/main.js"))
        .route_service("/static/main.css", ServeFile::new("static/main.css"))
        .route_service(
            "/static/worker.sql-wasm.js",
            ServeFile::new("static/worker.sql-wasm.js"),
        )
        .route_service(
            "/static/sql-wasm.wasm",
            ServeFile::new("static/sql-wasm.wasm"),
        )
        .route_service(
            "/static/worker.log-parser.js",
            ServeFile::new("static/worker.log-parser.js"),
        );

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[derive(Template)]
#[template(path = "root.twig.html")]
struct RootTemplate {
    apps: HashMap<String, Vec<String>>,
}

#[debug_handler]
async fn root() -> RootTemplate {
    let mut storage_path = Path::new("").to_path_buf();

    {
        let config = CONFIG.lock().unwrap();
        storage_path = Path::new(config.get("storage_path").unwrap()).to_owned();
    }

    let paths = read_dir(storage_path).unwrap();
    let mut apps: HashMap<String, Vec<String>> = HashMap::new();
    for path in paths {
        let path = path.unwrap();
        let path = path.path();
        let app = path.file_name().unwrap().to_str().unwrap().to_string();
        let logs = read_dir(path.join("ledgers")).unwrap();
        let mut log_dates: Vec<String> = Vec::new();
        for log in logs {
            let log = log.unwrap();
            let log = log.path();
            let log = log
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_string()
                .replace(".jsonl", "");
            log_dates.push(log);
        }
        apps.insert(app, log_dates);
    }
    RootTemplate { apps: apps }
}

#[debug_handler]
async fn create_key(req: Request<Body>) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();

    let app = req.headers().get("Lumberjack-App");
    if app.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Lumberjack-App header is required"
        )));
    }
    let app = to_kebab_case(app.unwrap().to_str().unwrap());

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();

        if key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!(
                "Invalid Master Authorization key"
            )));
        }

        app_path = Path::new(config.get("storage_path").unwrap()).join(&app);
        if !app_path.exists() {
            fs::create_dir_all(&app_path)?;
        }
    }

    app_path = app_path.join("keychain");
    let is_new = !app_path.exists();

    let app_keys_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&app_path)?;
    let mut writer = BufWriter::new(&app_keys_file);

    if is_new {
        writer.write_all(&VERSION.to_be_bytes())?; // 4 bytes
        writer.write_all(&1_u32.to_be_bytes())?; // 4 bytes
    } else {
        let mut reader = BufReader::new(&app_keys_file);
        reader.seek(SeekFrom::Start(4))?;
        let mut key_count_buffer = [0u8; 4];
        reader.read_exact(&mut key_count_buffer).unwrap();
        let mut key_count: u32 = u32::from_be_bytes(key_count_buffer);
        key_count += 1;

        writer.seek(SeekFrom::Start(4))?;
        writer.write_all(&key_count.to_be_bytes())?;
        writer.seek(SeekFrom::End(0))?;
    }

    writer.write_all(&1_u8.to_be_bytes())?;
    let new_key = generate_random_string(64);
    writer.write_all(&new_key.as_bytes())?;

    writer.flush()?;

    {
        let mut keychains = KEYS.lock().unwrap();
        if keychains.contains_key(&app) {
            let mut app_keychains = keychains.get_key_value(&app).unwrap().1.to_owned();
            app_keychains.push(new_key.to_owned());
            keychains.insert(app, app_keychains);
        } else {
            let keys = vec![new_key.to_owned()];
            keychains.insert(app, keys);
        }
    }

    return Ok(Response::new(Body::from(new_key)));
}

#[debug_handler]
async fn cleanup_logs(req: Request<Body>) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();

    let mut retention = Rentention::DELETE;
    let retention_date;
    let storage_path;
    {
        let config = CONFIG.lock().unwrap();

        if key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!(
                "Invalid Master Authorization key"
            )));
        }

        storage_path = config.get("storage_path").unwrap().to_owned();

        match config.get("mode").unwrap().as_str() {
            "delete" => retention = Rentention::DELETE,
            "archive" => retention = Rentention::ARCHIVE,
            _ => retention = Rentention::DELETE,
        }

        let retention_days = config
            .get("days_retained")
            .unwrap()
            .parse::<u32>()
            .unwrap_or(14);
        retention_date = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::days(retention_days.into()))
            .unwrap();
    }

    let storage_path = Path::new(&storage_path);
    let app_dirs = read_dir(storage_path)?;
    for app_dir in app_dirs {
        let app_dir = app_dir.unwrap();
        let app_dir = app_dir.path();
        let app = app_dir.file_name().unwrap().to_str().unwrap().to_string();
        let app_path = storage_path.join(app);

        let log_path = app_path.join("ledgers");
        if !log_path.exists() {
            continue;
        }

        let logs = read_dir(log_path)?;
        for log in logs {
            let log = log.unwrap();
            let log = log.path();
            let log_date = log.file_name().unwrap().to_str().unwrap().to_string();
            let log_date = log_date.replace(".jsonl", "");
            let log_date = chrono::DateTime::parse_from_rfc3339(log_date.as_str()).unwrap();
            if log_date < retention_date {
                match retention {
                    Rentention::DELETE => {
                        fs::remove_file(log)?;
                        let search_cache = app_path
                            .join("search")
                            .join(log_date.format("%Y-%m-%d").to_string());
                        if search_cache.exists() {
                            fs::remove_dir_all(search_cache)?;
                        }
                    }
                    Rentention::ARCHIVE => {
                        todo!("Archive logs in S3 or similar storage");
                    }
                }
            }
        }
    }

    return Ok(Response::new(Body::from("")));
}

#[debug_handler]
async fn delete_key(req: Request<Body>) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();

    let app = req.headers().get("Lumberjack-App");
    if app.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Lumberjack-App header is required"
        )));
    }
    let app = to_kebab_case(app.unwrap().to_str().unwrap());

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();

        if key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!(
                "Invalid Master Authorization key"
            )));
        }

        app_path = Path::new(config.get("storage_path").unwrap()).join(&app);
        if !app_path.exists() {
            fs::create_dir_all(&app_path)?;
        }
    }

    app_path = app_path.join("keychain");
    if !app_path.exists() {
        return Ok(Response::new(Body::from("")));
    }

    let body = axum::body::to_bytes(req.into_body(), std::usize::MAX).await?;
    if body.is_empty() {
        return Err(AppError(anyhow::anyhow!("Body is empty")));
    }

    let body = String::from_utf8(body.to_vec())?;

    let app_keys_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&app_path)?;

    let mut reader = BufReader::new(&app_keys_file);
    reader.seek(SeekFrom::Start(4))?;

    let mut key_count_buffer = [0u8; 4];
    reader.read_exact(&mut key_count_buffer).unwrap();
    let mut key_count: u32 = u32::from_be_bytes(key_count_buffer);

    let mut reader_offset = 8;
    let total_bytes = app_keys_file.metadata()?.len();
    let mut can_delete = false;

    loop {
        let mut is_active_buffer = [0u8; 1];
        reader.read_exact(&mut is_active_buffer).unwrap();
        let is_active = u8::from_be_bytes(is_active_buffer) == 1;

        let mut key_buffer = [0u8; 64];
        reader.read_exact(&mut key_buffer).unwrap();
        let key = String::from_utf8(key_buffer.to_vec()).unwrap();

        if key.trim() == body.trim() {
            can_delete = is_active;
            break;
        }

        reader_offset += 65;
        if reader_offset == total_bytes {
            break;
        }
    }

    if can_delete {
        let mut writer = BufWriter::new(&app_keys_file);

        // Decrement key count
        writer.seek(SeekFrom::Start(4))?;
        key_count -= 1;
        writer.write_all(&key_count.to_be_bytes())?;

        // Disable key
        writer.seek(SeekFrom::Start(reader_offset))?;
        writer.write_all(&0_u8.to_be_bytes())?;
        writer.flush()?;
    }

    {
        let mut keychain = KEYS.lock().unwrap();
        let mut app_keychain = keychain.get_key_value(&app).unwrap().1.to_owned();
        app_keychain.retain(|x| x != body.trim());
        keychain.insert(app, app_keychain);
    }

    return Ok(Response::new(Body::from("")));
}

#[debug_handler]
async fn list_keys(req: Request<Body>) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();

    let app = req.headers().get("Lumberjack-App");
    if app.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Lumberjack-App header is required"
        )));
    }
    let app = to_kebab_case(app.unwrap().to_str().unwrap());

    {
        let config = CONFIG.lock().unwrap();
        if key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!(
                "Invalid Master Authorization key"
            )));
        }
    }

    let keychains = KEYS.lock().unwrap();
    if keychains.contains_key(&app) {
        let app_keychains = keychains.get_key_value(&app).unwrap().1;
        let json_output = serde_json::to_string(&app_keychains)?;
        return Ok(Response::new(Body::from(json_output)));
    }

    return Err(AppError(anyhow::anyhow!(format!(
        "No applications exist with name {}",
        &app
    ))));
}

#[debug_handler]
async fn stream_log(
    PathExtractor(params): PathExtractor<(String, String)>,
    req: Request<Body>,
) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();
    let app = params.0.to_lowercase().replace(".", "").replace("/", "");
    let file = params.1.to_lowercase().replace(".", "").replace("/", "");

    if app.is_empty() {
        return Err(AppError(anyhow::anyhow!("App is required")));
    }
    if file.is_empty() {
        return Err(AppError(anyhow::anyhow!("File is required")));
    }

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();
        let keys = KEYS.lock().unwrap();

        let mut authorized = false;
        if keys.contains_key(&app) {
            let app_keys = keys.get(&app).unwrap();
            authorized = app_keys
                .iter()
                .filter_map(|k| {
                    return Some(*k == key);
                })
                .collect::<Vec<bool>>()
                .contains(&true);
        }

        if !authorized && key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
        }
        app_path = Path::new(config.get("storage_path").unwrap()).join(app);
    }

    let log_path = app_path.join("ledgers").join(format!("{}.jsonl", file));
    if !log_path.exists() {
        return Err(AppError(anyhow::anyhow!("Log file not found")));
    }

    let log = fs::read_to_string(log_path)?;
    Ok(Response::new(Body::from(log)))
}

#[debug_handler]
async fn log_size(
    PathExtractor(params): PathExtractor<(String, String)>,
    req: Request<Body>,
) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();
    let app = params.0.to_lowercase().replace(".", "").replace("/", "");
    let file = params.1.to_lowercase().replace(".", "").replace("/", "");

    if app.is_empty() {
        return Err(AppError(anyhow::anyhow!("App is required")));
    }
    if file.is_empty() {
        return Err(AppError(anyhow::anyhow!("File is required")));
    }

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();
        let keys = KEYS.lock().unwrap();

        let mut authorized = false;
        if keys.contains_key(&app) {
            let app_keys = keys.get(&app).unwrap();
            authorized = app_keys
                .iter()
                .filter_map(|k| {
                    return Some(*k == key);
                })
                .collect::<Vec<bool>>()
                .contains(&true);
        }

        if !authorized && key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
        }
        app_path = Path::new(config.get("storage_path").unwrap()).join(app);
    }

    let log_path = app_path.join("ledgers").join(format!("{}.jsonl", file));
    if !log_path.exists() {
        return Err(AppError(anyhow::anyhow!("Log file not found")));
    }

    let metadata = fs::metadata(log_path)?;
    let size = metadata.len() as f64;
    let size_mb: f64 = size / 1024.0 / 1024.0;
    let size = format!("{:.2} MB", size_mb);
    Ok(Response::new(Body::from(size.to_string())))
}

#[debug_handler]
async fn search_logs(
    PathExtractor(params): PathExtractor<(String, String)>,
    req: Request<Body>,
) -> Result<Response<Body>, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();
    let app = params.0.to_lowercase().replace(".", "").replace("/", "");
    let file = params.1.to_lowercase().replace(".", "").replace("/", "");

    if app.is_empty() {
        return Err(AppError(anyhow::anyhow!("App is required")));
    }
    if file.is_empty() {
        return Err(AppError(anyhow::anyhow!("File is required")));
    }

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();
        let keys = KEYS.lock().unwrap();

        let mut authorized = false;
        if keys.contains_key(&app) {
            let app_keys = keys.get(&app).unwrap();
            authorized = app_keys
                .iter()
                .filter_map(|k| {
                    return Some(*k == key);
                })
                .collect::<Vec<bool>>()
                .contains(&true);
        }

        if !authorized && key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
        }
        app_path = Path::new(config.get("storage_path").unwrap()).join(app);
    }

    let body = axum::body::to_bytes(req.into_body(), std::usize::MAX).await?;
    if body.is_empty() {
        return Err(AppError(anyhow::anyhow!("Body is empty")));
    }
    let query_string = String::from_utf8(body.to_vec())?;

    let log_path = app_path.join("search").join(file);
    if !log_path.exists() {
        return Err(AppError(anyhow::anyhow!("Log file not found")));
    }

    let output = Command::new("grep")
        .arg("-r")
        .arg("-l")
        .arg("-P")
        .arg("-i")
        .arg(format!(".*{}.*", query_string.trim()))
        .arg(log_path.to_str().unwrap())
        .output()
        .await?;
    let error = String::from_utf8(output.stderr)?;
    if !error.is_empty() {
        return Err(AppError(anyhow::anyhow!("Failed to search logs")));
    }
    let filenames = String::from_utf8(output.stdout)?;
    let filenames = filenames.split("\n").collect::<Vec<&str>>();
    let filenames = filenames
        .iter()
        .filter(|&x| !x.is_empty())
        .map(|x| x.rsplit_once('/').unwrap().1)
        .collect::<Vec<&str>>();
    let json_output = serde_json::to_string(&filenames)?;
    Ok(Response::new(Body::from(json_output)))
}

#[debug_handler]
async fn write_logs(req: Request<Body>) -> Result<StatusCode, AppError> {
    let key = req.headers().get("Authorization");
    if key.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Authorization header is required"
        )));
    }
    let key = key.unwrap().to_str().unwrap();

    let env = req.headers().get("Lumberjack-Env");
    let app = req.headers().get("Lumberjack-App");
    if app.is_none() || env.is_none() {
        return Err(AppError(anyhow::anyhow!(
            "Lumberjack-App and Lumberjack-Env headers are required"
        )));
    }
    let env = env.unwrap().to_str().unwrap().to_string();
    let app = to_kebab_case(app.unwrap().to_str().unwrap());

    let mut app_path: PathBuf = Path::new("").to_path_buf();
    {
        let config = CONFIG.lock().unwrap();
        let keys = KEYS.lock().unwrap();

        let mut authorized = false;
        if keys.contains_key(&app) {
            let app_keys = keys.get(&app).unwrap();
            authorized = app_keys
                .iter()
                .filter_map(|k| {
                    return Some(*k == key);
                })
                .collect::<Vec<bool>>()
                .contains(&true);
        }

        if !authorized && key != config.get("master_key").unwrap() {
            return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
        }

        app_path = Path::new(config.get("storage_path").unwrap()).join(app);
        if !app_path.exists() {
            fs::create_dir_all(&app_path)?;
        }
    }

    let body = axum::body::to_bytes(req.into_body(), std::usize::MAX).await?;
    if body.is_empty() {
        return Err(AppError(anyhow::anyhow!("Body is empty")));
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

    Ok(StatusCode::OK)
}

fn write_log_files(logs: Vec<Log>, app_path: PathBuf) -> Result<(), Error> {
    let daily_ledger_path = app_path.clone().join("ledgers");
    if !daily_ledger_path.exists() {
        fs::create_dir_all(&daily_ledger_path)?;
    }

    for log in logs {
        let log_date = DateTime::parse_from_rfc3339(log.timestamp.as_str())?
            .format("%Y-%m-%d")
            .to_string();

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
        line: None,
        timestamp: "".to_string(),
        message: "".to_string(),
        custom: HashMap::new(),
        branch: "".to_string(),
        env: "".to_string(),
        category: "".to_string(),
    };

    let first_line = lines.next().unwrap();
    let (level, timestamp) = first_line.split_once("-").unwrap();
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
    new_log.timestamp = timestamp.trim().to_string();

    loop {
        let binding = String::from("---[EOL]---");
        let line = lines.next().unwrap_or(&binding);

        let mut result = String::new();
        let mut section = LogSection::Message;
        let mut line_parts = line.split(":");
        match line_parts
            .nth(0)
            .unwrap_or("")
            .trim()
            .to_uppercase()
            .as_str()
        {
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
            LogSection::Line => new_log.line = Some(result.trim().parse().unwrap_or(0)),
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
        match lines
            .peek()
            .unwrap_or(&&String::from("---[EOL]---"))
            .trim()
            .to_uppercase()
            .as_str()
        {
            "---[EOL]---" => break,
            _ => {
                let line = lines.next().unwrap();
                result = result + "\n" + line.trim();
            }
        };
    }

    return result.trim().to_string();
}
