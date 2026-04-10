//! 提供 Python 解释器发现与脚本执行能力。

use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
};

use tokio::process::Command;

use crate::{command_runner::decode_command_output, skills::project_root_candidates};

/// 描述一个可尝试的 Python 解释器候选项。
#[derive(Clone)]
struct PythonCommandCandidate {
    /// Python 程序路径或命令名。
    program: String,
    /// 启动解释器前需要附加的前置参数。
    prefix_args: Vec<String>,
}

/// 查找项目内虚拟环境的 Python 可执行文件。
fn project_virtualenv_python() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let relative_path = PathBuf::from("control_agent/.venv/Scripts/python.exe");

    #[cfg(not(target_os = "windows"))]
    let relative_path = PathBuf::from("control_agent/.venv/bin/python");

    project_root_candidates()
        .into_iter()
        .map(|root| root.join(&relative_path))
        .find(|candidate| candidate.exists())
}

/// 构建当前平台可用的 Python 解释器候选列表。
fn python_command_candidates() -> Vec<PythonCommandCandidate> {
    let mut candidates = Vec::<PythonCommandCandidate>::new();

    if let Some(venv_python) = project_virtualenv_python() {
        candidates.push(PythonCommandCandidate {
            program: venv_python.display().to_string(),
            prefix_args: Vec::new(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(PythonCommandCandidate {
            program: "python".to_string(),
            prefix_args: Vec::new(),
        });
        candidates.push(PythonCommandCandidate {
            program: "py".to_string(),
            prefix_args: vec!["-3".to_string()],
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PythonCommandCandidate {
            program: "python3".to_string(),
            prefix_args: Vec::new(),
        });
        candidates.push(PythonCommandCandidate {
            program: "python".to_string(),
            prefix_args: Vec::new(),
        });
    }

    candidates
}

/// 使用可用的 Python 解释器执行指定脚本。
pub(crate) async fn run_python_script(
    script_path: &Path,
    args: &[String],
) -> Result<String, String> {
    let mut last_error = None;

    for candidate in python_command_candidates() {
        let mut command = Command::new(&candidate.program);
        command.args(&candidate.prefix_args);
        command.arg(script_path);
        command.args(args);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        match command.output().await {
            Ok(output) => {
                let stdout = decode_command_output(&output.stdout).trim().to_string();
                let stderr = decode_command_output(&output.stderr).trim().to_string();

                if output.status.success() {
                    return Ok(stdout);
                }

                last_error = Some(if stderr.is_empty() {
                    format!(
                        "Python 脚本执行失败，program={}, status={}",
                        candidate.program, output.status
                    )
                } else {
                    format!(
                        "Python 脚本执行失败，program={}, stderr={stderr}",
                        candidate.program
                    )
                });
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                last_error = Some(format!("未找到 Python 解释器：{}", candidate.program));
            }
            Err(error) => {
                last_error = Some(format!(
                    "启动 Python 脚本失败，program={}, error={error}",
                    candidate.program
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "无法执行 Python 脚本。".to_string()))
}
