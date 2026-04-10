//! 负责本地技能声明的发现、加载与启用状态维护。

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::SKILLS_DIR_NAME,
    logging::{log_error, log_info},
    models::{SkillDefinition, SkillSummary, SkillType},
};

/// 记录技能定义文件在磁盘中的位置及其解析结果。
#[derive(Debug, Clone)]
struct SkillRecord {
    /// 技能定义文件路径。
    path: PathBuf,
    /// 解析后的技能定义。
    definition: SkillDefinition,
}

/// 解析项目中的 `.skills` 目录位置。
pub(crate) fn project_skills_dir() -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    let mut push_candidate = |candidate: PathBuf| {
        if !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    };

    if let Ok(current_dir) = env::current_dir() {
        push_candidate(current_dir.join(SKILLS_DIR_NAME));

        if let Some(parent) = current_dir.parent() {
            push_candidate(parent.join(SKILLS_DIR_NAME));
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_candidate(manifest_dir.join(SKILLS_DIR_NAME));

    if let Some(parent) = manifest_dir.parent() {
        push_candidate(parent.join(SKILLS_DIR_NAME));
    }

    if let Ok(executable_path) = env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            push_candidate(executable_dir.join(SKILLS_DIR_NAME));

            if let Some(parent) = executable_dir.parent() {
                push_candidate(parent.join(SKILLS_DIR_NAME));
            }
        }
    }

    if let Some(existing_dir) = candidates.iter().find(|candidate| candidate.exists()) {
        return Some(existing_dir.clone());
    }

    candidates.into_iter().next()
}

/// 生成项目根目录候选集合，供脚本和虚拟环境查找复用。
pub(crate) fn project_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    let mut push_candidate = |candidate: PathBuf| {
        if !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    };

    if let Some(skills_dir) = project_skills_dir() {
        if let Some(parent) = skills_dir.parent() {
            push_candidate(parent.to_path_buf());
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        push_candidate(current_dir.clone());

        if let Some(parent) = current_dir.parent() {
            push_candidate(parent.to_path_buf());
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_candidate(manifest_dir.clone());

    if let Some(parent) = manifest_dir.parent() {
        push_candidate(parent.to_path_buf());
    }

    if let Ok(executable_path) = env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            push_candidate(executable_dir.to_path_buf());

            if let Some(parent) = executable_dir.parent() {
                push_candidate(parent.to_path_buf());
            }
        }
    }

    candidates
}

/// 从单个技能文件中解析技能定义。
fn load_skill_from_file(path: &Path) -> Option<SkillDefinition> {
    let contents = fs::read_to_string(path).ok()?;

    match serde_json::from_str::<SkillDefinition>(&contents) {
        Ok(skill) => Some(skill),
        Err(error) => {
            log_error(format!(
                "解析技能文件失败，path={}, error={error}",
                path.display()
            ));
            None
        }
    }
}

/// 加载磁盘上的所有技能记录。
fn load_all_skill_records() -> Vec<SkillRecord> {
    let Some(skills_dir) = project_skills_dir() else {
        log_error("无法确定当前工作目录，跳过 .skills 读取。");
        return Vec::new();
    };

    log_info(format!("skills 目录候选已解析为：{}", skills_dir.display()));

    if !skills_dir.exists() {
        log_info(format!(
            "未找到 skills 目录：{}，当前不加载额外技能。",
            skills_dir.display()
        ));
        return Vec::new();
    }

    let mut skill_paths = match fs::read_dir(&skills_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| extension.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            log_error(format!(
                "读取 skills 目录失败，path={}, error={error}",
                skills_dir.display()
            ));
            return Vec::new();
        }
    };

    skill_paths.sort();

    let records = skill_paths
        .iter()
        .filter_map(|path| {
            load_skill_from_file(path).map(|definition| SkillRecord {
                path: path.clone(),
                definition,
            })
        })
        .collect::<Vec<_>>();

    log_info(format!(
        "已加载 {} 个技能：{}",
        records.len(),
        if records.is_empty() {
            "(none)".to_string()
        } else {
            records
                .iter()
                .map(|record| format!("{}({})", record.definition.name, record.definition.id))
                .collect::<Vec<_>>()
                .join(", ")
        }
    ));

    records
}

/// 将完整技能定义转换为前端展示摘要。
fn to_skill_summary(skill: &SkillDefinition) -> SkillSummary {
    SkillSummary {
        id: skill.id.clone(),
        name: skill.name.clone(),
        description: skill.description.clone(),
        skill_type: skill.skill_type.clone(),
        enabled: skill.enabled,
        requires_confirmation: skill
            .tool
            .as_ref()
            .map(|tool| tool.requires_confirmation)
            .unwrap_or(false),
    }
}

/// 读取所有技能摘要，供前端技能面板使用。
pub(crate) fn load_skill_summaries() -> Vec<SkillSummary> {
    load_all_skill_records()
        .into_iter()
        .map(|record| to_skill_summary(&record.definition))
        .collect()
}

/// 读取所有已启用的技能定义，供模型执行时使用。
pub(crate) fn load_skill_definitions() -> Vec<SkillDefinition> {
    load_all_skill_records()
        .into_iter()
        .map(|record| record.definition)
        .filter(|skill| skill.enabled)
        .collect()
}

/// 更新某个技能的启用状态并回写到磁盘。
pub(crate) fn set_skill_enabled(skill_id: &str, enabled: bool) -> Result<SkillSummary, String> {
    let mut records = load_all_skill_records();
    let record = records
        .iter_mut()
        .find(|record| record.definition.id == skill_id)
        .ok_or_else(|| format!("未找到技能：{skill_id}"))?;

    record.definition.enabled = enabled;

    let serialized = serde_json::to_string_pretty(&record.definition)
        .map_err(|error| format!("序列化技能文件失败：{error}"))?;

    fs::write(&record.path, format!("{serialized}\n")).map_err(|error| {
        format!(
            "写入技能文件失败，path={}, error={error}",
            record.path.display()
        )
    })?;

    log_info(format!(
        "技能状态已更新，id={}, enabled={}, path={}",
        record.definition.id,
        record.definition.enabled,
        record.path.display()
    ));

    Ok(to_skill_summary(&record.definition))
}

/// 生成提示型技能的系统提示词片段。
pub(crate) fn build_prompt_skill_section(skills: &[SkillDefinition]) -> String {
    let sections = skills
        .iter()
        .filter(|skill| matches!(skill.skill_type, SkillType::Prompt))
        .map(|skill| {
            let instruction = skill.instruction.as_deref().unwrap_or("未提供额外指令。");
            format!(
                "- 技能名称: {}\n  描述: {}\n  指令: {}",
                skill.name, skill.description, instruction
            )
        })
        .collect::<Vec<_>>();

    if sections.is_empty() {
        "当前未加载额外的提示型技能。".to_string()
    } else {
        sections.join("\n")
    }
}

/// 生成工具型技能的系统提示词片段。
pub(crate) fn build_tool_skill_section(skills: &[SkillDefinition]) -> String {
    let sections = skills
        .iter()
        .filter(|skill| matches!(skill.skill_type, SkillType::Tool))
        .filter_map(|skill| {
            skill.tool.as_ref().map(|tool| {
                format!(
                    "- 技能名称: {}\n  工具名: {}\n  描述: {}\n  需要确认: {}",
                    skill.name,
                    tool.name,
                    tool.description,
                    if tool.requires_confirmation {
                        "是"
                    } else {
                        "否"
                    }
                )
            })
        })
        .collect::<Vec<_>>();

    if sections.is_empty() {
        "当前未加载额外的工具型技能。".to_string()
    } else {
        sections.join("\n")
    }
}
