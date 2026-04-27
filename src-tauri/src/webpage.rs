//! Public webpage fetching and readability-style extraction.

use std::time::Duration;

use encoding_rs::Encoding;
use reqwest::{
    header::{self, HeaderMap, HeaderValue},
    redirect::Policy,
    Client, Url,
};
use scraper::{ElementRef, Html, Selector};

use crate::models::ReadWebPageRequest;

const DEFAULT_WEBPAGE_MAX_CHARS: usize = 8_000;
const MAX_WEBPAGE_MAX_CHARS: usize = 20_000;
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 20;

fn clamp_max_chars(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_WEBPAGE_MAX_CHARS)
        .clamp(1_000, MAX_WEBPAGE_MAX_CHARS)
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip_text(text: &str, max_chars: usize) -> String {
    let normalized = normalize_text(text);

    if normalized.chars().count() <= max_chars {
        normalized
    } else {
        let mut clipped = normalized.chars().take(max_chars).collect::<String>();
        clipped.push_str("...");
        clipped
    }
}

fn parse_charset(content_type: &str) -> Option<&str> {
    content_type.split(';').find_map(|part| {
        let trimmed = part.trim();
        trimmed
            .strip_prefix("charset=")
            .map(|value| value.trim_matches('"'))
    })
}

fn decode_response_bytes(bytes: &[u8], content_type: &str) -> String {
    if let Some(charset) = parse_charset(content_type) {
        if let Some(encoding) = Encoding::for_label(charset.as_bytes()) {
            let (decoded, _, _) = encoding.decode(bytes);
            return decoded.into_owned();
        }
    }

    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| {
        let (decoded, _, _) = encoding_rs::UTF_8.decode(bytes);
        decoded.into_owned()
    })
}

fn selector(pattern: &str) -> Selector {
    Selector::parse(pattern).expect("static selector must be valid")
}

fn extract_meta_content(document: &Html, pattern: &str) -> Option<String> {
    let selector = selector(pattern);

    document
        .select(&selector)
        .find_map(|element| element.value().attr("content"))
        .map(normalize_text)
        .filter(|value| !value.is_empty())
}

fn extract_title(document: &Html) -> Option<String> {
    let title_selector = selector("title");
    let h1_selector = selector("h1");

    document
        .select(&title_selector)
        .next()
        .map(|node| normalize_text(&node.text().collect::<Vec<_>>().join(" ")))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            document
                .select(&h1_selector)
                .next()
                .map(|node| normalize_text(&node.text().collect::<Vec<_>>().join(" ")))
                .filter(|value| !value.is_empty())
        })
}

fn extract_description(document: &Html) -> Option<String> {
    extract_meta_content(document, r#"meta[name="description"]"#)
        .or_else(|| extract_meta_content(document, r#"meta[property="og:description"]"#))
}

fn collect_root_lines(root: ElementRef<'_>) -> Vec<String> {
    let content_selector = selector("h1, h2, h3, p, li, pre, code, blockquote");
    let mut lines = Vec::<String>::new();

    for node in root.select(&content_selector) {
        let text = normalize_text(&node.text().collect::<Vec<_>>().join(" "));
        if text.len() >= 2 {
            lines.push(text);
        }
    }

    if lines.is_empty() {
        let fallback = normalize_text(&root.text().collect::<Vec<_>>().join(" "));
        if fallback.len() >= 2 {
            lines.push(fallback);
        }
    }

    lines
}

fn extract_body_lines(document: &Html) -> Vec<String> {
    let root_selector = selector(
        r#"article, main, [role="main"], .article-content, .entry-content, .post-content, .content, #content, body"#,
    );
    let mut unique = std::collections::HashSet::<String>::new();
    let mut lines = Vec::<String>::new();

    for root in document.select(&root_selector) {
        for line in collect_root_lines(root) {
            let dedupe_key = line.to_ascii_lowercase();
            if unique.insert(dedupe_key) {
                lines.push(line);
            }
        }

        if !lines.is_empty() {
            break;
        }
    }

    lines
}

fn clip_lines(lines: &[String], max_chars: usize) -> String {
    let mut output = String::new();

    for line in lines {
        let candidate = if output.is_empty() {
            line.clone()
        } else {
            format!("{output}\n{line}")
        };

        if candidate.chars().count() > max_chars {
            break;
        }

        output = candidate;
    }

    if output.is_empty() {
        output
    } else if output.chars().count() < max_chars {
        output
    } else {
        clip_text(&output, max_chars)
    }
}

fn looks_like_html(content_type: &str, body: &str) -> bool {
    content_type.contains("text/html")
        || content_type.contains("application/xhtml")
        || body.trim_start().starts_with("<!DOCTYPE html")
        || body.trim_start().starts_with("<html")
}

fn format_webpage_output(
    url: &str,
    content_type: &str,
    title: Option<&str>,
    description: Option<&str>,
    content: &str,
) -> String {
    let mut sections = vec![format!("网页读取结果\nURL: {url}")];

    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        sections.push(format!("标题: {title}"));
    }

    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        sections.push(format!("摘要: {description}"));
    }

    if !content_type.trim().is_empty() {
        sections.push(format!("Content-Type: {content_type}"));
    }

    if content.trim().is_empty() {
        sections.push("正文: (empty)".to_string());
    } else {
        sections.push(format!("正文:\n{content}"));
    }

    sections.join("\n\n")
}

fn extract_html_content(url: &str, content_type: &str, body: &str, max_chars: usize) -> String {
    let document = Html::parse_document(body);
    let title = extract_title(&document);
    let description = extract_description(&document);
    let body_text = clip_lines(&extract_body_lines(&document), max_chars);

    format_webpage_output(
        url,
        content_type,
        title.as_deref(),
        description.as_deref(),
        &body_text,
    )
}

fn extract_non_html_content(url: &str, content_type: &str, body: &str, max_chars: usize) -> String {
    let content = clip_text(body, max_chars);
    format_webpage_output(url, content_type, None, None, &content)
}

fn build_client() -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        ),
    );
    headers.insert(
        header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
    );

    Client::builder()
        .default_headers(headers)
        .redirect(Policy::limited(10))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent("AI-Universal-Assistant/0.1 webpage-reader")
        .build()
        .map_err(|error| format!("Failed to create webpage reader client: {error}"))
}

pub(crate) async fn read_webpage(request: ReadWebPageRequest) -> Result<String, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err("URL cannot be empty.".to_string());
    }

    let parsed_url = Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }

    let client = build_client()?;
    let response = client
        .get(parsed_url.clone())
        .send()
        .await
        .map_err(|error| format!("Failed to fetch webpage: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Webpage request failed with status {}",
            response.status()
        ));
    }

    if let Some(length) = response.content_length() {
        if length as usize > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Webpage is too large to read safely ({} bytes).",
                length
            ));
        }
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read webpage body: {error}"))?;

    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "Webpage body is too large to read safely ({} bytes).",
            bytes.len()
        ));
    }

    let decoded_body = decode_response_bytes(&bytes, &content_type);
    let max_chars = clamp_max_chars(request.max_chars.map(|value| value as usize));

    Ok(if looks_like_html(&content_type, &decoded_body) {
        extract_html_content(parsed_url.as_str(), &content_type, &decoded_body, max_chars)
    } else {
        extract_non_html_content(parsed_url.as_str(), &content_type, &decoded_body, max_chars)
    })
}

#[cfg(test)]
pub(crate) fn extract_html_content_for_test(url: &str, content_type: &str, body: &str) -> String {
    extract_html_content(url, content_type, body, DEFAULT_WEBPAGE_MAX_CHARS)
}
