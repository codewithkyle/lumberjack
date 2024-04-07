use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use askama_axum::Template;
use std::env;
use rand::{distributions::Alphanumeric, thread_rng};
use rand::Rng;
use owo_colors::OwoColorize;

#[macro_use]
extern crate dotenv_codegen;

#[tokio::main]
async fn main() {
    let ascii_name = r#"
888                             888                        d8b                   888      
888                             888                        Y8P                   888      
888                             888                                              888      
888      888  888 88888b.d88b.  88888b.   .d88b.    8d888 8888  8888b.   .d8888b 888  888 
888      888  888 888 "888 "888 b888 "88b d8P  Y8b 888P"  "888     "88b d88P"    888 .88P 
888      888  888 888  888  888 8888  888 88888888 888     888 .d888888 888      888888K  
888      Y88b 888 888  888  888 8888 d88P Y8b.     888     888 888  888 Y88b.    888 "88b 
88888888  "Y88888 888  888  888 888888P"   "Y8888  888     888 "Y888888  "Y8888P 888  888 
                                                           888                         
                                                          d88P                         
                                                         888P
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

    let app = Router::new()
        .route("/", get(root));

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> HelloTemplate<'static> {
    HelloTemplate { name: "mom" }
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


#[derive(Template)]
#[template(path = "hello.twig.html")]
struct HelloTemplate<'a> {
    name: &'a str,
}
