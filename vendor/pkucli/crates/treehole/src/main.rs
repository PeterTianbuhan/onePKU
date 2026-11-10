#[tokio::main]
async fn main() -> std::process::ExitCode {
    match pku_treehole::run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("树洞操作失败。请在本机重试；链接和凭证已隐藏。");
            std::process::ExitCode::FAILURE
        }
    }
}
