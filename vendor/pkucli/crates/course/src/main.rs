#[tokio::main]
async fn main() -> std::process::ExitCode {
    match pku_course::run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {}", pku_course::safe_error_message(&error));
            std::process::ExitCode::FAILURE
        }
    }
}
