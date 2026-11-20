use noto_server::{app, Config, Server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let listen = config.listen;
    let state = Server::open(config)?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    println!("Noto 网页服务：http://{}", listener.local_addr()?);
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("无法监听终止信号");
        tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
