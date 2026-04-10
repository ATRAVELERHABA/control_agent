//! 实现 DuckDuckGo 搜索工具的脚本定位、调用与结果格式化。

use std::path::PathBuf;

use crate::{
    constants::DUCKDUCKGO_SEARCH_SCRIPT_RELATIVE_PATH,
    logging::{log_info, preview_text},
    models::{clamp_search_result_limit, DuckDuckGoSearchPayload, RunDuckDuckGoSearchRequest},
    python::run_python_script,
    skills::project_root_candidates,
};

/// 查找 DuckDuckGo 搜索脚本的实际路径。
fn duckduckgo_search_script_path() -> Option<PathBuf> {
    let candidates = project_root_candidates()
        .into_iter()
        .map(|root| root.join(DUCKDUCKGO_SEARCH_SCRIPT_RELATIVE_PATH))
        .collect::<Vec<_>>();

    if let Some(existing_path) = candidates.iter().find(|candidate| candidate.exists()) {
        return Some(existing_path.clone());
    }

    candidates.into_iter().next()
}

/// 将脚本返回的结构化搜索结果格式化成适合模型阅读的文本。
pub(crate) fn format_duckduckgo_search_results(payload: DuckDuckGoSearchPayload) -> String {
    if payload.results.is_empty() {
        return format!("DuckDuckGo 没有找到与“{}”相关的结果。", payload.query);
    }

    let mut sections = vec![format!("DuckDuckGo 搜索结果：{}", payload.query)];

    for (index, result) in payload.results.iter().enumerate() {
        let mut section = format!("{}. {}", index + 1, result.title.trim());

        if !result.url.trim().is_empty() {
            section.push_str(&format!("\n链接: {}", result.url.trim()));
        }

        if !result.snippet.trim().is_empty() {
            section.push_str(&format!("\n摘要: {}", result.snippet.trim()));
        }

        sections.push(section);
    }

    sections.join("\n\n")
}

/// 执行 DuckDuckGo 搜索脚本并返回格式化后的结果文本。
pub(crate) async fn execute_duckduckgo_search(
    request: RunDuckDuckGoSearchRequest,
) -> Result<String, String> {
    let query = request.query.trim().to_string();

    if query.is_empty() {
        return Err("Search query cannot be empty.".to_string());
    }

    let max_results = clamp_search_result_limit(request.max_results);
    let script_path = duckduckgo_search_script_path()
        .ok_or_else(|| "无法定位 DuckDuckGo 搜索脚本。".to_string())?;
    let args = vec![
        "--query".to_string(),
        query.clone(),
        "--max-results".to_string(),
        max_results.to_string(),
    ];

    log_info(format!(
        "开始执行 DuckDuckGo 搜索，query={}, max_results={}, script={}",
        query,
        max_results,
        script_path.display()
    ));

    let raw_output = run_python_script(&script_path, &args).await?;
    let payload: DuckDuckGoSearchPayload = serde_json::from_str(&raw_output)
        .map_err(|error| format!("解析 DuckDuckGo 搜索结果失败：{error}"))?;
    let formatted_output = format_duckduckgo_search_results(payload);

    log_info(format!(
        "DuckDuckGo 搜索完成，query={}, output_preview={}",
        query,
        preview_text(&formatted_output, 200)
    ));

    Ok(formatted_output)
}
