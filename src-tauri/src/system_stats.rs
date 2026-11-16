use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemStats {
    cpu_percent: Option<f64>,
    memory_percent: Option<f64>,
    received_bytes: Option<u64>,
    sent_bytes: Option<u64>,
    battery_percent: Option<u8>,
    plugged_in: bool,
}

#[tauri::command]
pub(crate) async fn system_stats() -> SystemStats {
    #[cfg(target_os = "macos")]
    {
        macos::sample().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        SystemStats::default()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::SystemStats;
    use tokio::{
        process::Command,
        time::{timeout, Duration},
    };

    async fn output(path: &str, args: &[&str]) -> Option<String> {
        let result = timeout(
            Duration::from_secs(4),
            Command::new(path)
                .args(args)
                .env("LC_ALL", "C")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        result
            .status
            .success()
            .then(|| String::from_utf8_lossy(&result.stdout).into_owned())
    }

    pub(super) async fn sample() -> SystemStats {
        let (top, memory_size, network, battery) = tokio::join!(
            output("/usr/bin/top", &["-l", "2", "-s", "1", "-n", "0"]),
            output("/usr/sbin/sysctl", &["-n", "hw.memsize"]),
            output("/usr/sbin/netstat", &["-ibn"]),
            output("/usr/bin/pmset", &["-g", "batt"]),
        );
        let top = top.as_deref().unwrap_or_default();
        let (received_bytes, sent_bytes) = network.as_deref().and_then(network_bytes).unzip();
        let battery = battery.as_deref().unwrap_or_default();

        SystemStats {
            cpu_percent: cpu_percent(top),
            memory_percent: memory_size
                .as_deref()
                .and_then(|total| memory_percent(top, total)),
            received_bytes,
            sent_bytes,
            battery_percent: battery
                .lines()
                .find(|line| line.contains("InternalBattery"))
                .and_then(|line| {
                    line.split_whitespace()
                        .find_map(|word| word.strip_suffix("%;")?.parse().ok())
                }),
            plugged_in: battery
                .lines()
                .next()
                .is_some_and(|line| line.contains("AC Power")),
        }
    }

    fn cpu_percent(top: &str) -> Option<f64> {
        let idle: f64 = top
            .lines()
            .rev()
            .find(|line| line.starts_with("CPU usage:"))?
            .split_whitespace()
            .rev()
            .nth(1)?
            .strip_suffix('%')?
            .parse()
            .ok()?;
        Some((100.0 - idle).clamp(0.0, 100.0))
    }

    fn memory_percent(top: &str, total: &str) -> Option<f64> {
        let total: f64 = total.trim().parse().ok()?;
        let used = top
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix("PhysMem: "))?
            .split_whitespace()
            .next()?;
        let (number, unit) = used.split_at(used.len().checked_sub(1)?);
        let scale = match unit {
            "B" => 1.0,
            "K" => 1024.0,
            "M" => 1024.0 * 1024.0,
            "G" => 1024.0 * 1024.0 * 1024.0,
            "T" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
            _ => return None,
        };
        if total <= 0.0 {
            return None;
        }
        let used = number.parse::<f64>().ok()? * scale;
        Some((used / total * 100.0).clamp(0.0, 100.0))
    }

    fn network_bytes(network: &str) -> Option<(u64, u64)> {
        // Count Ethernet and Wi-Fi link rows once, excluding loopback and VPN overlays.
        let mut found = false;
        let mut received = 0u64;
        let mut sent = 0u64;
        for line in network.lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            let [name, _, link, .., incoming, _, _, outgoing, _] = fields.as_slice() else {
                continue;
            };
            if !name.strip_prefix("en").is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
            }) || !link.starts_with("<Link#")
            {
                continue;
            }
            let (Ok(incoming), Ok(outgoing)) = (incoming.parse::<u64>(), outgoing.parse::<u64>())
            else {
                continue;
            };
            found = true;
            received = received.saturating_add(incoming);
            sent = sent.saturating_add(outgoing);
        }
        found.then_some((received, sent))
    }
}
