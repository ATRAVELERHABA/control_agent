//! Python interpreter discovery and helper process launching.

use std::{
    env,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
};

use tokio::process::{Child, Command};

use crate::{
    command_runner::decode_command_output, runtime_paths::content_root_candidates,
    skills::project_root_candidates,
};

#[derive(Clone)]
struct PythonCommandCandidate {
    program: String,
    prefix_args: Vec<String>,
    env_vars: Vec<(String, String)>,
}

fn bundled_python_relative_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from("python.exe")
    }

    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("bin/python3")
    }
}

fn bundled_python_home() -> Option<PathBuf> {
    let executable_relative_path = bundled_python_relative_path();

    content_root_candidates()
        .into_iter()
        .map(|root| root.join("python-runtime"))
        .find(|candidate| candidate.join(&executable_relative_path).exists())
}

fn bundled_site_packages() -> Option<PathBuf> {
    content_root_candidates()
        .into_iter()
        .map(|root| root.join("control_agent/site-packages"))
        .find(|candidate| candidate.exists())
}

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

fn python_command_candidates() -> Vec<PythonCommandCandidate> {
    let mut candidates = Vec::<PythonCommandCandidate>::new();

    if let (Some(python_home), Some(site_packages)) =
        (bundled_python_home(), bundled_site_packages())
    {
        candidates.push(PythonCommandCandidate {
            program: python_home
                .join(bundled_python_relative_path())
                .display()
                .to_string(),
            prefix_args: Vec::new(),
            env_vars: vec![
                ("PYTHONHOME".to_string(), python_home.display().to_string()),
                (
                    "PYTHONPATH".to_string(),
                    site_packages.display().to_string(),
                ),
                ("PYTHONNOUSERSITE".to_string(), "1".to_string()),
            ],
        });
    }

    if let Some(venv_python) = project_virtualenv_python() {
        candidates.push(PythonCommandCandidate {
            program: venv_python.display().to_string(),
            prefix_args: Vec::new(),
            env_vars: Vec::new(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(PythonCommandCandidate {
            program: "python".to_string(),
            prefix_args: Vec::new(),
            env_vars: Vec::new(),
        });
        candidates.push(PythonCommandCandidate {
            program: "py".to_string(),
            prefix_args: vec!["-3".to_string()],
            env_vars: Vec::new(),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PythonCommandCandidate {
            program: "python3".to_string(),
            prefix_args: Vec::new(),
            env_vars: Vec::new(),
        });
        candidates.push(PythonCommandCandidate {
            program: "python".to_string(),
            prefix_args: Vec::new(),
            env_vars: Vec::new(),
        });
    }

    candidates
}

fn apply_candidate_env(command: &mut Command, candidate: &PythonCommandCandidate) {
    for (name, value) in &candidate.env_vars {
        command.env(name, value);
    }

    if candidate.env_vars.is_empty() {
        return;
    }

    if let Some(current_path) = env::var_os("PATH") {
        command.env("PATH", current_path);
    }
}

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
        apply_candidate_env(&mut command, &candidate);

        match command.output().await {
            Ok(output) => {
                let stdout = decode_command_output(&output.stdout).trim().to_string();
                let stderr = decode_command_output(&output.stderr).trim().to_string();

                if output.status.success() {
                    return Ok(stdout);
                }

                last_error = Some(if stderr.is_empty() {
                    format!(
                        "Python script failed, program={}, status={}",
                        candidate.program, output.status
                    )
                } else {
                    format!(
                        "Python script failed, program={}, stderr={stderr}",
                        candidate.program
                    )
                });
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                last_error = Some(format!(
                    "Python interpreter not found: {}",
                    candidate.program
                ));
            }
            Err(error) => {
                last_error = Some(format!(
                    "Failed to start Python script, program={}, error={error}",
                    candidate.program
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Unable to execute Python script.".to_string()))
}

pub(crate) async fn start_python_script(
    script_path: &Path,
    args: &[String],
) -> Result<Child, String> {
    let mut last_error = None;

    for candidate in python_command_candidates() {
        let mut command = Command::new(&candidate.program);
        command.args(&candidate.prefix_args);
        command.arg("-u");
        command.arg(script_path);
        command.args(args);
        apply_candidate_env(&mut command, &candidate);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                last_error = Some(format!(
                    "Python interpreter not found: {}",
                    candidate.program
                ));
            }
            Err(error) => {
                last_error = Some(format!(
                    "Failed to start Python script, program={}, error={error}",
                    candidate.program
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Unable to start Python script.".to_string()))
}
