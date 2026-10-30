use std::io::Read;
fn main() {
    let root = std::env::args().nth(1).unwrap_or("dist".into());
    let core = campus_core::Core::new();
    let server = tiny_http::Server::http("127.0.0.1:1421").unwrap();
    println!("OnePKU live preview: http://127.0.0.1:1421");
    for mut req in server.incoming_requests() {
        let core = core.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            let header = |n: &str| {
                req.headers()
                    .iter()
                    .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(n))
                    .map(|h| h.value.as_str().to_string())
            };
            let host = header("host");
            let origin = header("origin");
            let ok = host.as_deref() == Some("127.0.0.1:1421")
                && origin
                    .as_deref()
                    .is_none_or(|o| o == "http://127.0.0.1:1421");
            let mut response = if !ok {
                tiny_http::Response::from_string("Forbidden").with_status_code(403)
            } else if req.url() == "/api" && req.method() == &tiny_http::Method::Post {
                if header("x-onepku").as_deref() != Some("1")
                    || header("content-type").as_deref() != Some("application/json")
                {
                    tiny_http::Response::from_string("Forbidden").with_status_code(403)
                } else {
                    let mut bytes = vec![];
                    let _ = req.as_reader().take(16385).read_to_end(&mut bytes);
                    match serde_json::from_slice::<campus_core::Request>(&bytes) {
                        Ok(
                            campus_core::Request::CommitSubmission { .. }
                            | campus_core::Request::TrashLocalMaterial { .. },
                        ) => tiny_http::Response::from_string("Writes require the native app")
                            .with_status_code(403),
                        Ok(r) if bytes.len() <= 16384 => tiny_http::Response::from_string(
                            serde_json::to_string(&core.call(r)).unwrap(),
                        )
                        .with_header(
                            tiny_http::Header::from_bytes("Content-Type", "application/json")
                                .unwrap(),
                        ),
                        _ => tiny_http::Response::from_string("Invalid request")
                            .with_status_code(400),
                    }
                }
            } else if req.method() == &tiny_http::Method::Get {
                // 方案文件名是中文，浏览器会百分号编码；先解码再做越界检查。
                let path = decode_path(req.url().split('?').next().unwrap_or("/"));
                let relative = match path.as_deref() {
                    Some("/") => "index.html",
                    Some(p) => p.trim_start_matches('/'),
                    None => "..",
                };
                if relative.contains("..") || relative.contains('\\') || relative.contains('\0') {
                    tiny_http::Response::from_string("Forbidden").with_status_code(403)
                } else {
                    match std::fs::read(std::path::Path::new(&root).join(relative)) {
                        Ok(b) => tiny_http::Response::from_data(b).with_header(
                            tiny_http::Header::from_bytes(
                                "Content-Type",
                                mime_guess::from_path(relative)
                                    .first_or_octet_stream()
                                    .as_ref(),
                            )
                            .unwrap(),
                        ),
                        Err(_) => {
                            tiny_http::Response::from_string("Not found").with_status_code(404)
                        }
                    }
                }
            } else {
                tiny_http::Response::from_string("Method not allowed").with_status_code(405)
            };
            response
                .add_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap());
            response.add_header(
                tiny_http::Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap(),
            );
            let _ = req.respond(response);
        });
    }
}

/// 解码 URL 路径里的 %XX；不是 UTF-8 时返回 None。
fn decode_path(path: &str) -> Option<String> {
    percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()
        .map(|p| p.into_owned())
}
