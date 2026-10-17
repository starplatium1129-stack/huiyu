#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    huiyu_runtime::run().await
}
