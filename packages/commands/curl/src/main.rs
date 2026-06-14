use std::io::{Read, Write};

fn write_stdout(s: &[u8]) {
    let mut out = std::io::stdout();
    if out.write_all(s).is_err() {
        std::process::exit(141);
    }
    if out.flush().is_err() {
        std::process::exit(141);
    }
}

fn write_stderr(s: &str) {
    let mut err = std::io::stderr();
    err.write_all(s.as_bytes()).ok();
    err.flush().ok();
}

#[allow(dead_code)]
fn read_stdin_all() -> Vec<u8> {
    let mut buf = Vec::new();
    std::io::stdin().read_to_end(&mut buf).ok();
    buf
}

struct CurlOptions {
    url: Option<String>,
    method: Option<String>,
    headers: Vec<(String, String)>,
    data: Option<String>,
    output: Option<String>,
    silent: bool,
    include_headers: bool,
    verbose: bool,
    follow_redirects: bool,
    write_out: Option<String>,
    connect_timeout: Option<u64>,
    fail_on_error: bool,
}

impl CurlOptions {
    fn new() -> Self {
        Self {
            url: None,
            method: None,
            headers: Vec::new(),
            data: None,
            output: None,
            silent: false,
            include_headers: false,
            verbose: false,
            follow_redirects: false,
            write_out: None,
            connect_timeout: None,
            fail_on_error: false,
        }
    }

    fn effective_method(&self) -> &str {
        if let Some(ref m) = self.method {
            m.as_str()
        } else if self.data.is_some() {
            "POST"
        } else {
            "GET"
        }
    }
}

fn parse_args(args: &[String]) -> Result<CurlOptions, String> {
    let mut opts = CurlOptions::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-X" | "--request" => {
                i += 1;
                if i >= args.len() {
                    return Err("option -X requires an argument".to_string());
                }
                opts.method = Some(args[i].clone());
            }
            "-H" | "--header" => {
                i += 1;
                if i >= args.len() {
                    return Err("option -H requires an argument".to_string());
                }
                let header = &args[i];
                if let Some(pos) = header.find(':') {
                    let name = header[..pos].trim().to_string();
                    let value = header[pos + 1..].trim().to_string();
                    opts.headers.push((name, value));
                } else {
                    return Err(format!("invalid header format: {}", header));
                }
            }
            "-d" | "--data" => {
                i += 1;
                if i >= args.len() {
                    return Err("option -d requires an argument".to_string());
                }
                opts.data = Some(args[i].clone());
            }
            "-o" | "--output" => {
                i += 1;
                if i >= args.len() {
                    return Err("option -o requires an argument".to_string());
                }
                opts.output = Some(args[i].clone());
            }
            "-s" | "--silent" => {
                opts.silent = true;
            }
            "-i" | "--include" => {
                opts.include_headers = true;
            }
            "-v" | "--verbose" => {
                opts.verbose = true;
            }
            "-L" | "--location" => {
                opts.follow_redirects = true;
            }
            "-w" | "--write-out" => {
                i += 1;
                if i >= args.len() {
                    return Err("option -w requires an argument".to_string());
                }
                opts.write_out = Some(args[i].clone());
            }
            "--connect-timeout" => {
                i += 1;
                if i >= args.len() {
                    return Err("option --connect-timeout requires an argument".to_string());
                }
                match args[i].parse::<u64>() {
                    Ok(v) => opts.connect_timeout = Some(v),
                    Err(_) => return Err(format!("invalid timeout value: {}", args[i])),
                }
            }
            "-f" | "--fail" => {
                opts.fail_on_error = true;
            }
            a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => {
                let chars: Vec<char> = a[1..].chars().collect();
                let mut j = 0;
                while j < chars.len() {
                    match chars[j] {
                        's' => opts.silent = true,
                        'i' => opts.include_headers = true,
                        'v' => opts.verbose = true,
                        'L' => opts.follow_redirects = true,
                        'f' => opts.fail_on_error = true,
                        'X' => {
                            i += 1;
                            if i >= args.len() {
                                return Err("option -X requires an argument".to_string());
                            }
                            opts.method = Some(args[i].clone());
                            j = chars.len();
                        }
                        'H' => {
                            i += 1;
                            if i >= args.len() {
                                return Err("option -H requires an argument".to_string());
                            }
                            let header = &args[i];
                            if let Some(pos) = header.find(':') {
                                let name = header[..pos].trim().to_string();
                                let value = header[pos + 1..].trim().to_string();
                                opts.headers.push((name, value));
                            } else {
                                return Err(format!("invalid header format: {}", header));
                            }
                            j = chars.len();
                        }
                        'd' => {
                            i += 1;
                            if i >= args.len() {
                                return Err("option -d requires an argument".to_string());
                            }
                            opts.data = Some(args[i].clone());
                            j = chars.len();
                        }
                        'o' => {
                            i += 1;
                            if i >= args.len() {
                                return Err("option -o requires an argument".to_string());
                            }
                            opts.output = Some(args[i].clone());
                            j = chars.len();
                        }
                        'w' => {
                            i += 1;
                            if i >= args.len() {
                                return Err("option -w requires an argument".to_string());
                            }
                            opts.write_out = Some(args[i].clone());
                            j = chars.len();
                        }
                        c => {
                            return Err(format!("unknown option: -{}", c));
                        }
                    }
                    j += 1;
                }
            }
            _ => {
                if opts.url.is_none() {
                    opts.url = Some(arg.clone());
                } else {
                    return Err(format!("unexpected argument: {}", arg));
                }
            }
        }
        i += 1;
    }

    Ok(opts)
}

fn format_headers(headers: &[(String, String)]) -> String {
    let mut result = String::new();
    for (name, value) in headers {
        result.push_str(name);
        result.push_str(": ");
        result.push_str(value);
        result.push_str("\r\n");
    }
    result
}

fn format_write_out(format: &str, status: u16, headers: &[(String, String)]) -> String {
    let mut result = format.to_string();
    result = result.replace("%{http_code}", &status.to_string());
    let content_type = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    result = result.replace("%{content_type}", content_type);
    result = result.replace("\\n", "\n");
    result
}

#[derive(Debug, PartialEq)]
enum UrlScheme {
    Http,
    Https,
}

fn parse_url(url: &str) -> Result<(UrlScheme, String, String), String> {
    let (scheme, rest) = if url.starts_with("https://") {
        (UrlScheme::Https, &url[8..])
    } else if url.starts_with("http://") {
        (UrlScheme::Http, &url[7..])
    } else {
        return Err(format!("unsupported URL scheme: {}", url));
    };

    let (authority, path_with_query) = match rest.find('/') {
        Some(pos) => (rest[..pos].to_string(), rest[pos..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    };

    Ok((scheme, authority, path_with_query))
}

fn make_request(opts: &CurlOptions) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let url = opts.url.as_deref().ok_or("no URL specified")?;
    let method = opts.effective_method();
    let body = opts.data.as_ref().map(|d| d.as_bytes().to_vec());
    let timeout_ms = opts.connect_timeout.map(|s| s * 1000);

    if opts.verbose {
        write_stderr(&format!("> {} {} HTTP/1.1\r\n", method, url));
        for (name, value) in &opts.headers {
            write_stderr(&format!("> {}: {}\r\n", name, value));
        }
        write_stderr(">\r\n");
    }

    do_http_request(method, url, &opts.headers, body.as_deref(), timeout_ms)
}

#[cfg(target_arch = "wasm32")]
fn do_http_request(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
    timeout_ms: Option<u64>,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    use crate::bindings::wasi::http::types::{
        Method, Scheme, Fields, OutgoingRequest, OutgoingBody, IncomingBody,
        RequestOptions,
    };
    use crate::bindings::wasi::http::outgoing_handler;
    use crate::bindings::wasi::io::streams::StreamError;

    let method_val = match method.to_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "HEAD" => Method::Head,
        "OPTIONS" => Method::Options,
        "PATCH" => Method::Patch,
        "CONNECT" => Method::Connect,
        "TRACE" => Method::Trace,
        other => Method::Other(other.to_string()),
    };

    let (url_scheme, authority, path_with_query) = parse_url(url)?;
    let scheme = match url_scheme {
        UrlScheme::Http => Scheme::Http,
        UrlScheme::Https => Scheme::Https,
    };

    let fields = Fields::new();
    for (name, value) in headers {
        fields.append(&name.to_lowercase(), &value.as_bytes().to_vec())
            .map_err(|_| format!("failed to set header: {}", name))?;
    }

    let request = OutgoingRequest::new(fields);
    request.set_method(&method_val).map_err(|_| "failed to set method")?;
    request.set_scheme(Some(&scheme)).map_err(|_| "failed to set scheme")?;
    request.set_authority(Some(&authority)).map_err(|_| "failed to set authority")?;
    request.set_path_with_query(Some(&path_with_query)).map_err(|_| "failed to set path")?;

    if let Some(body_data) = body {
        let out_body = request.body().map_err(|_| "failed to get outgoing body")?;
        let stream = out_body.write().map_err(|_| "failed to get body write stream")?;
        stream.blocking_write_and_flush(body_data)
            .map_err(|_| "failed to write request body")?;
        drop(stream);
        OutgoingBody::finish(out_body, None).map_err(|_| "failed to finish outgoing body")?;
    } else {
        let out_body = request.body().map_err(|_| "failed to get outgoing body")?;
        OutgoingBody::finish(out_body, None).map_err(|_| "failed to finish outgoing body")?;
    }

    let options = RequestOptions::new();
    if let Some(ms) = timeout_ms {
        options.set_connect_timeout(Some(ms * 1_000_000))
            .map_err(|_| "failed to set connect timeout")?;
    }

    let future_response = outgoing_handler::handle(request, Some(options))
        .map_err(|e| format!("request failed: {:?}", e))?;

    let pollable = future_response.subscribe();
    pollable.block();

    let response_result = future_response.get()
        .ok_or("response not ready")?
        .map_err(|_| "response error")?
        .map_err(|e| format!("HTTP error: {:?}", e))?;

    let status = response_result.status();

    let resp_headers = response_result.headers();
    let header_entries: Vec<(String, String)> = resp_headers.entries()
        .into_iter()
        .map(|(name, value)| {
            (name, String::from_utf8_lossy(&value).to_string())
        })
        .collect();

    let incoming_body = response_result.consume()
        .map_err(|_| "failed to consume response body")?;
    let body_stream = incoming_body.stream()
        .map_err(|_| "failed to get body stream")?;

    let mut response_body = Vec::new();
    loop {
        match body_stream.blocking_read(65536) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                response_body.extend_from_slice(&chunk);
            }
            Err(StreamError::Closed) => break,
            Err(StreamError::LastOperationFailed(_)) => break,
        }
    }
    drop(body_stream);
    IncomingBody::finish(incoming_body);

    Ok((status, header_entries, response_body))
}

#[cfg(not(target_arch = "wasm32"))]
fn do_http_request(
    _method: &str,
    _url: &str,
    _headers: &[(String, String)],
    _body: Option<&[u8]>,
    _timeout_ms: Option<u64>,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    Err("HTTP requests require WASM runtime".to_string())
}

fn run(args: &[String]) -> i32 {
    let opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            write_stderr(&format!("curl: {}\n", e));
            return 2;
        }
    };

    if opts.url.is_none() {
        write_stderr("curl: no URL specified\n");
        write_stderr("curl: try 'curl --help' for more information\n");
        return 2;
    }

    let max_redirects = if opts.follow_redirects { 10 } else { 0 };
    let mut current_url = opts.url.clone().unwrap();
    let mut redirects = 0;

    loop {
        let request_opts = CurlOptions {
            url: Some(current_url.clone()),
            method: opts.method.clone(),
            headers: opts.headers.clone(),
            data: opts.data.clone(),
            output: opts.output.clone(),
            silent: opts.silent,
            include_headers: opts.include_headers,
            verbose: opts.verbose,
            follow_redirects: opts.follow_redirects,
            write_out: opts.write_out.clone(),
            connect_timeout: opts.connect_timeout,
            fail_on_error: opts.fail_on_error,
        };

        let (status, headers, body) = match make_request(&request_opts) {
            Ok(r) => r,
            Err(e) => {
                if !opts.silent {
                    write_stderr(&format!("curl: (6) {}\n", e));
                }
                return 6;
            }
        };

        if opts.follow_redirects && (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            redirects += 1;
            if redirects > max_redirects {
                if !opts.silent {
                    write_stderr("curl: (47) Maximum redirects followed\n");
                }
                return 47;
            }
            if let Some(location) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("location")).map(|(_, v)| v.clone()) {
                if location.starts_with("http://") || location.starts_with("https://") {
                    current_url = location;
                } else if location.starts_with('/') {
                    let (scheme_str, rest) = if current_url.starts_with("https://") {
                        ("https://", &current_url[8..])
                    } else {
                        ("http://", &current_url[7..])
                    };
                    let authority = rest.split('/').next().unwrap_or("");
                    current_url = format!("{}{}{}", scheme_str, authority, location);
                } else {
                    current_url = location;
                }
                continue;
            }
        }

        if opts.verbose {
            write_stderr(&format!("< HTTP/1.1 {} \r\n", status));
            for (name, value) in &headers {
                write_stderr(&format!("< {}: {}\r\n", name, value));
            }
            write_stderr("<\r\n");
        }

        if opts.include_headers {
            let header_text = format!("HTTP/1.1 {}\r\n{}\r\n", status, format_headers(&headers));
            if let Some(ref output_path) = opts.output {
                let mut content = header_text.into_bytes();
                content.extend_from_slice(&body);
                if std::fs::write(output_path, &content).is_err() {
                    if !opts.silent {
                        write_stderr(&format!("curl: (23) Failed to write to '{}'\n", output_path));
                    }
                    return 23;
                }
            } else {
                write_stdout(header_text.as_bytes());
                write_stdout(&body);
            }
        } else if let Some(ref output_path) = opts.output {
            if std::fs::write(output_path, &body).is_err() {
                if !opts.silent {
                    write_stderr(&format!("curl: (23) Failed to write to '{}'\n", output_path));
                }
                return 23;
            }
        } else {
            write_stdout(&body);
        }

        if let Some(ref format) = opts.write_out {
            let formatted = format_write_out(format, status, &headers);
            write_stdout(formatted.as_bytes());
        }

        if opts.fail_on_error && status >= 400 {
            if !opts.silent {
                write_stderr(&format!(
                    "curl: (22) The requested URL returned error: {}\n",
                    status
                ));
            }
            return 22;
        }

        return 0;
    }
}

#[cfg(target_arch = "wasm32")]
mod bindings {
    wit_bindgen::generate!({
        world: "curl",
        path: "./wit",
        generate_all
    });
}

#[cfg(not(target_arch = "wasm32"))]
mod bindings {}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd_args = args[1..].to_vec();
    let code = run(&cmd_args);
    if code != 0 {
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_args_basic_url() {
        let args = vec!["http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.url, Some("http://example.com".to_string()));
        assert_eq!(opts.effective_method(), "GET");
    }

    #[test]
    fn test_parse_args_method() {
        let args = vec!["-X".to_string(), "POST".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.effective_method(), "POST");
    }

    #[test]
    fn test_parse_args_data_implies_post() {
        let args = vec!["-d".to_string(), "body".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.effective_method(), "POST");
        assert_eq!(opts.data, Some("body".to_string()));
    }

    #[test]
    fn test_parse_args_headers() {
        let args = vec![
            "-H".to_string(), "Content-Type: application/json".to_string(),
            "-H".to_string(), "Authorization: Bearer token".to_string(),
            "http://example.com".to_string(),
        ];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.headers.len(), 2);
        assert_eq!(opts.headers[0], ("Content-Type".to_string(), "application/json".to_string()));
        assert_eq!(opts.headers[1], ("Authorization".to_string(), "Bearer token".to_string()));
    }

    #[test]
    fn test_parse_args_combined_flags() {
        let args = vec!["-sifvL".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert!(opts.silent);
        assert!(opts.include_headers);
        assert!(opts.fail_on_error);
        assert!(opts.verbose);
        assert!(opts.follow_redirects);
    }

    #[test]
    fn test_parse_args_output() {
        let args = vec!["-o".to_string(), "/tmp/out".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.output, Some("/tmp/out".to_string()));
    }

    #[test]
    fn test_parse_args_write_out() {
        let args = vec!["-w".to_string(), "%{http_code}".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.write_out, Some("%{http_code}".to_string()));
    }

    #[test]
    fn test_parse_args_connect_timeout() {
        let args = vec!["--connect-timeout".to_string(), "5".to_string(), "http://example.com".to_string()];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.connect_timeout, Some(5));
    }

    #[test]
    fn test_parse_url_http() {
        let (scheme, authority, path) = parse_url("http://example.com/path?q=1").unwrap();
        assert_eq!(scheme, UrlScheme::Http);
        assert_eq!(authority, "example.com");
        assert_eq!(path, "/path?q=1");
    }

    #[test]
    fn test_parse_url_https_no_path() {
        let (scheme, authority, path) = parse_url("https://example.com").unwrap();
        assert_eq!(scheme, UrlScheme::Https);
        assert_eq!(authority, "example.com");
        assert_eq!(path, "/");
    }

    #[test]
    fn test_parse_url_with_port() {
        let (scheme, authority, path) = parse_url("http://localhost:8080/api").unwrap();
        assert_eq!(scheme, UrlScheme::Http);
        assert_eq!(authority, "localhost:8080");
        assert_eq!(path, "/api");
    }

    #[test]
    fn test_parse_url_invalid_scheme() {
        let result = parse_url("ftp://example.com");
        assert!(result.is_err());
    }

    #[test]
    fn test_format_write_out() {
        let headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
        ];
        let result = format_write_out("%{http_code} %{content_type}\\n", 200, &headers);
        assert_eq!(result, "200 application/json\n");
    }

    #[test]
    fn test_format_headers() {
        let headers = vec![
            ("Content-Type".to_string(), "text/html".to_string()),
            ("X-Custom".to_string(), "value".to_string()),
        ];
        let result = format_headers(&headers);
        assert_eq!(result, "Content-Type: text/html\r\nX-Custom: value\r\n");
    }

    #[test]
    fn test_no_url_error() {
        let args: Vec<String> = vec!["-s".to_string()];
        let opts = parse_args(&args).unwrap();
        assert!(opts.url.is_none());
    }

    #[test]
    fn test_parse_args_long_options() {
        let args = vec![
            "--request".to_string(), "PUT".to_string(),
            "--header".to_string(), "X-Key: val".to_string(),
            "--data".to_string(), "payload".to_string(),
            "--output".to_string(), "/tmp/file".to_string(),
            "--silent".to_string(),
            "--include".to_string(),
            "--verbose".to_string(),
            "--location".to_string(),
            "--fail".to_string(),
            "--connect-timeout".to_string(), "10".to_string(),
            "--write-out".to_string(), "%{http_code}".to_string(),
            "http://example.com".to_string(),
        ];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.effective_method(), "PUT");
        assert_eq!(opts.headers[0], ("X-Key".to_string(), "val".to_string()));
        assert_eq!(opts.data, Some("payload".to_string()));
        assert_eq!(opts.output, Some("/tmp/file".to_string()));
        assert!(opts.silent);
        assert!(opts.include_headers);
        assert!(opts.verbose);
        assert!(opts.follow_redirects);
        assert!(opts.fail_on_error);
        assert_eq!(opts.connect_timeout, Some(10));
        assert_eq!(opts.write_out, Some("%{http_code}".to_string()));
    }

    #[test]
    fn test_parse_args_missing_arg_for_x() {
        let args = vec!["-X".to_string()];
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn test_parse_args_invalid_header() {
        let args = vec!["-H".to_string(), "no-colon".to_string(), "http://example.com".to_string()];
        assert!(parse_args(&args).is_err());
    }
}
