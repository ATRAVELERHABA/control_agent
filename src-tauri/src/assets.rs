//! 管理用户上传到对话中的临时附件资源。

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};

use crate::{
    logging::timestamp_ms,
    models::{AssetKind, AssetSummary, RegisterAssetRequest},
};

/// 表示已注册到后端内存索引中的资源。
#[derive(Debug, Clone)]
pub(crate) struct StoredAsset {
    /// 后端分配的资源 ID。
    pub(crate) asset_id: String,
    /// 资源类型。
    pub(crate) kind: AssetKind,
    /// 展示文件名。
    pub(crate) display_name: String,
    /// MIME 类型。
    pub(crate) mime_type: String,
    /// 文件大小。
    pub(crate) size_bytes: u64,
    /// 已写入磁盘的真实路径。
    pub(crate) file_path: PathBuf,
}

/// 全局附件索引，按会话内存保留。
static ASSET_REGISTRY: LazyLock<Mutex<HashMap<String, StoredAsset>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 资源 ID 自增序列，避免同毫秒冲突。
static ASSET_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 计算附件类型，当前仅支持图片和音频。
fn detect_asset_kind(mime_type: &str, file_name: &str) -> Result<AssetKind, String> {
    let lowered_mime = mime_type.to_ascii_lowercase();
    let lowered_name = file_name.to_ascii_lowercase();

    if lowered_mime.starts_with("image/") {
        return Ok(AssetKind::Image);
    }

    if lowered_mime.starts_with("audio/") {
        return Ok(AssetKind::Audio);
    }

    let image_extensions = [
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".heic",
    ];
    if image_extensions
        .iter()
        .any(|extension| lowered_name.ends_with(extension))
    {
        return Ok(AssetKind::Image);
    }

    let audio_extensions = [
        ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".webm",
    ];
    if audio_extensions
        .iter()
        .any(|extension| lowered_name.ends_with(extension))
    {
        return Ok(AssetKind::Audio);
    }

    Err(format!(
        "暂不支持的附件类型：mime_type={mime_type}, file_name={file_name}"
    ))
}

/// 提取文件扩展名，避免写入临时目录后失去类型信息。
fn file_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.trim())
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default()
}

/// 过滤文件名中的危险字符。
fn sanitize_file_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized
    }
}

/// 生成唯一的资源 ID。
fn next_asset_id() -> String {
    let counter = ASSET_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("asset-{}-{counter}", timestamp_ms())
}

/// 获取附件临时目录。
fn asset_root_dir() -> PathBuf {
    env::temp_dir().join("ai-universal-assistant-assets")
}

/// 将附件类型转换为子目录名。
fn asset_kind_dir_name(kind: &AssetKind) -> &'static str {
    match kind {
        AssetKind::Image => "images",
        AssetKind::Audio => "audio",
    }
}

/// 将内存记录转换为对外摘要。
fn to_asset_summary(asset: &StoredAsset) -> AssetSummary {
    AssetSummary {
        asset_id: asset.asset_id.clone(),
        kind: asset.kind.clone(),
        display_name: asset.display_name.clone(),
        mime_type: asset.mime_type.clone(),
        size_bytes: asset.size_bytes,
    }
}

/// 注册前端发送上来的附件字节流。
pub(crate) fn register_asset(request: RegisterAssetRequest) -> Result<AssetSummary, String> {
    if request.bytes.is_empty() {
        return Err("附件内容不能为空。".to_string());
    }

    let display_name = sanitize_file_name(&request.file_name);
    let kind = detect_asset_kind(&request.mime_type, &display_name)?;
    let asset_id = next_asset_id();
    let extension = file_extension(&display_name);
    let asset_dir = asset_root_dir().join(asset_kind_dir_name(&kind));
    fs::create_dir_all(&asset_dir).map_err(|error| {
        format!(
            "创建附件目录失败，path={}, error={error}",
            asset_dir.display()
        )
    })?;

    let file_path = asset_dir.join(format!("{asset_id}{extension}"));
    fs::write(&file_path, &request.bytes).map_err(|error| {
        format!(
            "写入附件文件失败，path={}, error={error}",
            file_path.display()
        )
    })?;

    let asset = StoredAsset {
        asset_id: asset_id.clone(),
        kind,
        display_name,
        mime_type: request.mime_type,
        size_bytes: request.bytes.len() as u64,
        file_path,
    };

    let summary = to_asset_summary(&asset);
    ASSET_REGISTRY
        .lock()
        .map_err(|_| "附件注册表已损坏，无法加锁。".to_string())?
        .insert(asset_id, asset);

    Ok(summary)
}

/// 根据 `asset_id` 获取已注册的附件。
pub(crate) fn get_asset(asset_id: &str) -> Result<StoredAsset, String> {
    ASSET_REGISTRY
        .lock()
        .map_err(|_| "附件注册表已损坏，无法加锁。".to_string())?
        .get(asset_id)
        .cloned()
        .ok_or_else(|| format!("未找到附件：{asset_id}"))
}
