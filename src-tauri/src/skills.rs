//! Local skill discovery, loading, and enablement.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::{SKILLS_DIR_NAME, TOOL_NAME},
    logging::{log_error, log_info},
    models::{SkillDefinition, SkillSummary, SkillType},
    runtime_paths::{app_data_dir, content_root_candidates},
};

#[derive(Debug, Clone)]
struct SkillRecord {
    path: PathBuf,
    definition: SkillDefinition,
}

pub(crate) fn project_skills_dir() -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    let mut push_candidate = |candidate: PathBuf| {
        if !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    };

    if let Some(app_data_dir) = app_data_dir() {
        push_candidate(app_data_dir.join(SKILLS_DIR_NAME));
    }

    for root in content_root_candidates() {
        push_candidate(root.join(SKILLS_DIR_NAME));
    }

    if let Some(existing_dir) = candidates.iter().find(|candidate| candidate.exists()) {
        return Some(existing_dir.clone());
    }

    candidates.into_iter().next()
}

pub(crate) fn project_root_candidates() -> Vec<PathBuf> {
    content_root_candidates()
}

fn copy_skill_file_if_missing(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }

    let contents = fs::read(source).map_err(|error| {
        format!(
            "Failed to read bundled skill file, path={}, error={error}",
            source.display()
        )
    })?;
    fs::write(target, contents).map_err(|error| {
        format!(
            "Failed to write local skill file, path={}, error={error}",
            target.display()
        )
    })
}

pub(crate) fn ensure_skill_store() -> Result<(), String> {
    let Some(app_data_dir) = app_data_dir() else {
        return Ok(());
    };

    let target_dir = app_data_dir.join(SKILLS_DIR_NAME);
    let source_dir = content_root_candidates()
        .into_iter()
        .map(|root| root.join(SKILLS_DIR_NAME))
        .find(|candidate| candidate.exists() && candidate != &target_dir);

    let Some(source_dir) = source_dir else {
        return Ok(());
    };

    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Failed to create local skills directory: {error}"))?;

    let entries = fs::read_dir(&source_dir).map_err(|error| {
        format!(
            "Failed to read bundled skills directory, path={}, error={error}",
            source_dir.display()
        )
    })?;

    for entry in entries.filter_map(Result::ok) {
        let source_path = entry.path();
        if !source_path.is_file() {
            continue;
        }

        let Some(file_name) = source_path.file_name() else {
            continue;
        };
        let target_path = target_dir.join(file_name);
        copy_skill_file_if_missing(&source_path, &target_path)?;
    }

    log_info(format!(
        "Synchronized local skill store from bundled resources, source={}, target={}",
        source_dir.display(),
        target_dir.display()
    ));

    Ok(())
}

fn load_skill_from_file(path: &Path) -> Option<SkillDefinition> {
    let contents = fs::read_to_string(path).ok()?;

    match serde_json::from_str::<SkillDefinition>(&contents) {
        Ok(skill) => Some(skill),
        Err(error) => {
            log_error(format!(
                "Failed to parse skill file, path={}, error={error}",
                path.display()
            ));
            None
        }
    }
}

fn load_all_skill_records() -> Vec<SkillRecord> {
    let Some(skills_dir) = project_skills_dir() else {
        log_error("Could not resolve the .skills directory.");
        return Vec::new();
    };

    log_info(format!(
        "Resolved skills directory candidate: {}",
        skills_dir.display()
    ));

    if !skills_dir.exists() {
        log_info(format!(
            "No .skills directory found at {}; no extra skills will be loaded.",
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
                "Failed to read skills directory, path={}, error={error}",
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
        "Loaded {} skills: {}",
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

fn write_skill_record(record: &SkillRecord) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(&record.definition)
        .map_err(|error| format!("Failed to serialize skill file: {error}"))?;

    fs::write(&record.path, format!("{serialized}\n")).map_err(|error| {
        format!(
            "Failed to write skill file, path={}, error={error}",
            record.path.display()
        )
    })
}

pub(crate) fn load_skill_summaries() -> Vec<SkillSummary> {
    load_all_skill_records()
        .into_iter()
        .map(|record| to_skill_summary(&record.definition))
        .collect()
}

pub(crate) fn load_skill_definitions() -> Vec<SkillDefinition> {
    load_all_skill_records()
        .into_iter()
        .map(|record| record.definition)
        .filter(|skill| skill.enabled)
        .collect()
}

pub(crate) fn set_skill_enabled(skill_id: &str, enabled: bool) -> Result<SkillSummary, String> {
    let mut records = load_all_skill_records();
    let record = records
        .iter_mut()
        .find(|record| record.definition.id == skill_id)
        .ok_or_else(|| format!("Skill not found: {skill_id}"))?;

    record.definition.enabled = enabled;

    write_skill_record(record)?;

    log_info(format!(
        "Updated skill state, id={}, enabled={}, path={}",
        record.definition.id,
        record.definition.enabled,
        record.path.display()
    ));

    Ok(to_skill_summary(&record.definition))
}

pub(crate) fn set_skill_requires_confirmation(
    skill_id: &str,
    requires_confirmation: bool,
) -> Result<SkillSummary, String> {
    let mut records = load_all_skill_records();
    let record = records
        .iter_mut()
        .find(|record| record.definition.id == skill_id)
        .ok_or_else(|| format!("Skill not found: {skill_id}"))?;

    let tool = record
        .definition
        .tool
        .as_mut()
        .ok_or_else(|| format!("Skill does not expose a configurable tool: {skill_id}"))?;

    tool.requires_confirmation = requires_confirmation;
    let updated_requires_confirmation = tool.requires_confirmation;
    write_skill_record(record)?;

    log_info(format!(
        "Updated skill confirmation requirement, id={}, requires_confirmation={}, path={}",
        record.definition.id,
        updated_requires_confirmation,
        record.path.display()
    ));

    Ok(to_skill_summary(&record.definition))
}

pub(crate) fn terminal_command_requires_confirmation() -> bool {
    load_all_skill_records()
        .into_iter()
        .find_map(|record| {
            record
                .definition
                .tool
                .as_ref()
                .filter(|tool| tool.name == TOOL_NAME)
                .map(|tool| tool.requires_confirmation)
        })
        .unwrap_or(true)
}

pub(crate) fn build_prompt_skill_section(skills: &[SkillDefinition]) -> String {
    let sections = skills
        .iter()
        .filter(|skill| matches!(skill.skill_type, SkillType::Prompt))
        .map(|skill| {
            let instruction = skill
                .instruction
                .as_deref()
                .unwrap_or("No additional instruction provided.");
            format!(
                "- Skill name: {}\n  Description: {}\n  Instruction: {}",
                skill.name, skill.description, instruction
            )
        })
        .collect::<Vec<_>>();

    if sections.is_empty() {
        "No extra prompt skills are currently loaded.".to_string()
    } else {
        sections.join("\n")
    }
}

pub(crate) fn build_tool_skill_section(skills: &[SkillDefinition]) -> String {
    let sections = skills
        .iter()
        .filter(|skill| matches!(skill.skill_type, SkillType::Tool))
        .filter_map(|skill| {
            skill.tool.as_ref().map(|tool| {
                format!(
                    "- Skill name: {}\n  Tool name: {}\n  Description: {}\n  Requires confirmation: {}",
                    skill.name,
                    tool.name,
                    tool.description,
                    if tool.requires_confirmation { "yes" } else { "no" }
                )
            })
        })
        .collect::<Vec<_>>();

    if sections.is_empty() {
        "No extra tool skills are currently loaded.".to_string()
    } else {
        sections.join("\n")
    }
}
