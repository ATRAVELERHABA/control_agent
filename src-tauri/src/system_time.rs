//! Current system time tool.

use chrono::{Local, Utc};

fn format_system_time_output() -> String {
    let local_now = Local::now();
    let utc_now = Utc::now();
    let offset = local_now.offset().to_string();

    format!(
        "Current system time\nLocal time: {}\nUTC time: {}\nUnix timestamp: {}\nTimezone offset: {}",
        local_now.to_rfc3339(),
        utc_now.to_rfc3339(),
        local_now.timestamp(),
        offset
    )
}

pub(crate) fn get_current_system_time() -> String {
    format_system_time_output()
}

#[cfg(test)]
pub(crate) fn format_system_time_output_for_test() -> String {
    format_system_time_output()
}
