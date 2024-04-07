use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use askama_axum::Template;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(root));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> HelloTemplate<'static> {
    HelloTemplate { name: "mom" }
}

#[derive(Template)]
#[template(path = "hello.twig.html")]
struct HelloTemplate<'a> {
    name: &'a str,
}
