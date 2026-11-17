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
        let (top, memory_size, vm, network, battery) = tokio::join!(
            output("/usr/bin/top", &["-l", "2", "-s", "1", "-n", "0"]),
            output("/usr/sbin/sysctl", &["-n", "hw.memsize"]),
            output("/usr/bin/vm_stat", &[]),
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
                .and_then(|total| memory_percent(vm.as_deref()?, total)),
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

    fn memory_percent(vm: &str, total: &str) -> Option<f64> {
        let total: u64 = total.trim().parse().ok()?;
        let page_size: u64 = vm
            .lines()
            .next()?
            .split_once("page size of ")?
            .1
            .split_whitespace()
            .next()?
            .parse()
            .ok()?;
        if total == 0 || page_size == 0 {
            return None;
        }
        let pages = |name: &str| -> Option<u64> {
            vm.lines()
                .find_map(|line| line.strip_prefix(name))?
                .trim()
                .trim_end_matches('.')
                .parse()
                .ok()
        };
        // Activity Monitor separates reusable file cache from used physical memory.
        // vm_stat's displayed free count excludes speculative pages. Include those
        // as available too. The complement retains wired/compressed and newer
        // kernel allocations (e.g. tag storage), without double-counting them.
        let available = pages("Pages free:")?
            .checked_add(pages("Pages speculative:")?)?
            .checked_add(pages("File-backed pages:")?)?
            .checked_add(pages("Pages purgeable:")?)?
            .checked_mul(page_size)?;
        let used = total.checked_sub(available)?;
        Some(used as f64 / total as f64 * 100.0)
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
    #[cfg(test)]
    mod tests {
        use super::memory_percent;

        fn snapshot(page_size: u64) -> String {
            format!(
                "Mach Virtual Memory Statistics: (page size of {page_size} bytes)\n\
                 Pages free: 10000.\n\
                 Pages speculative: 2000.\n\
                 Pages purgeable: 10000.\n\
                 File-backed pages: 650000.\n\
                 Anonymous pages: 600000.\n\
                 Pages wired down: 150000.\n\
                 Pages occupied by compressor: 60000.\n\
                 Pages stored in compressor: 160000.\n"
            )
        }

        #[test]
        fn excludes_available_pages_but_retains_kernel_overhead() {
            let vm = snapshot(16384);
            let total = 25769803776.0;
            let actual = memory_percent(&vm, "25769803776\n").unwrap();
            let expected = (total - 672000.0 * 16384.0) / total * 100.0;
            assert!((actual - expected).abs() < 0.000001);
            // Compressed logical contents are not extra physical memory.
            assert_eq!(
                memory_percent(&vm, "25769803776"),
                memory_percent(&vm.replace("160000", "400000"), "25769803776")
            );
            // More cached files reduce used memory, rather than inflating it.
            assert!(
                memory_percent(&vm.replace("650000", "750000"), "25769803776").unwrap() < actual
            );
        }

        #[test]
        fn respects_intel_page_size() {
            assert_eq!(memory_percent(&snapshot(4096), "5505024000"), Some(50.0));
        }

        #[test]
        fn invalid_samples_are_unavailable_not_misleading_percentages() {
            let vm = snapshot(16384);
            assert_eq!(memory_percent("", "25769803776"), None);
            assert_eq!(memory_percent(&vm, "0"), None);
            assert_eq!(memory_percent(&vm, "invalid"), None);
            assert_eq!(memory_percent(&snapshot(0), "25769803776"), None);
            assert_eq!(
                memory_percent(&vm.replace("Pages free:", "Missing:"), "25769803776"),
                None
            );
            assert_eq!(
                memory_percent(&vm.replace("650000", "18446744073709551615"), "25769803776"),
                None
            );
        }

        #[test]
        fn live_vm_sample_is_parseable() {
            let vm = std::process::Command::new("/usr/bin/vm_stat")
                .env("LC_ALL", "C")
                .output()
                .unwrap();
            let total = std::process::Command::new("/usr/sbin/sysctl")
                .args(["-n", "hw.memsize"])
                .output()
                .unwrap();
            let percent = memory_percent(
                std::str::from_utf8(&vm.stdout).unwrap(),
                std::str::from_utf8(&total.stdout).unwrap(),
            )
            .unwrap();
            assert!((0.0..=100.0).contains(&percent));
            eprintln!("Live used memory: {percent:.1}%");
        }
    }
}
