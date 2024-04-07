use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::get,
    routing::post,
    Router,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use askama_axum::Template;
use std::env;
use rand::{distributions::Alphanumeric, thread_rng};
use rand::Rng;
use owo_colors::OwoColorize;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use anyhow::{Result, Error};

#[macro_use]
extern crate dotenv_codegen;

#[tokio::main]
async fn main() {
    let ascii_name = r#"
888                             888                        d8b                   888      
888                             888                        Y8P                   888      
888                             888                                              888      
888      888  888 88888b.d88b.  88888b.   .d888b.   8d888 8888  8888b.   .d8888b 888  888 
888      888  888 888 "888 "888 b88  "88b d8P  Y8b 888P"  "888     "88b d88P"    888 .88P 
888      888  888 888  888  888 888   888 88888888 888     888 .d888888 888      888888K  
88888888 Y88b 888 888  888  888 888  d88P Y8b.     888     888 888  888 Y88b.    888 "88b 
88888888  "Y88888 888  888  888 888888P"   "Y8888  888     888 "Y888888  "Y8888P 888  888 
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
        storage_path: storage_path.clone().into(),
        master_key: master_key.clone(),
    });

    let app = Router::new()
        .route("/", get(root))
        .route("/logs", post(move |req| write_logs(req, config.clone())));

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

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

async fn root() -> HelloTemplate<'static> {
    HelloTemplate { name: "mom" }
}

#[derive(Template)]
#[template(path = "hello.twig.html")]
struct HelloTemplate<'a> {
    name: &'a str,
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
    let env = env.unwrap().to_str().unwrap();

    if key != config.master_key {
        return Err(AppError(anyhow::anyhow!("Invalid Authorization key")));
    }

    let app_path = config.storage_path.join(app);
    if !app_path.exists() {
        fs::create_dir_all(&app_path)?;
    }

    Ok(())
}
