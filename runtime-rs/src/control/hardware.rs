use serde_json::{Value, json};
#[cfg(all(windows, not(test)))]
use std::time::Duration;

pub(super) async fn local_hardware() -> Value {
    #[cfg(test)]
    {
        json!({"ramBytes":null,"devices":[]})
    }
    #[cfg(all(windows, not(test)))]
    {
        let mut command = tokio::process::Command::new("nvidia-smi.exe");
        command
            .args([
                "--query-gpu=name,memory.total,memory.free,driver_version",
                "--format=csv,noheader,nounits",
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(3), command.output()).await;
        let devices = output
            .ok()
            .and_then(Result::ok)
            .filter(|o| o.status.success())
            .map(|o| parse_nvidia(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default();
        json!({"ramBytes":system_ram(),"devices":devices})
    }
    #[cfg(all(not(windows), not(test)))]
    {
        json!({"ramBytes":null,"devices":[]})
    }
}

#[cfg(any(windows, test))]
fn parse_nvidia(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let values: Vec<_> = line.split(',').map(str::trim).collect();
        if values.len() != 4 { return None; }
        let mib = |value: &str| value.parse::<u64>().ok().and_then(|n| n.checked_mul(1024 * 1024));
        Some(json!({"name":values[0],"type":"cuda","vramBytes":mib(values[1]),"freeVramBytes":mib(values[2]),"driverVersion":values[3]}))
    }).collect()
}

#[cfg(all(windows, not(test)))]
fn system_ram() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total: u64,
        available: u64,
        page_total: u64,
        page_available: u64,
        virtual_total: u64,
        virtual_available: u64,
        extended: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: std::mem::size_of::<MemoryStatus>() as u32,
        load: 0,
        total: 0,
        available: 0,
        page_total: 0,
        page_available: 0,
        virtual_total: 0,
        virtual_available: 0,
        extended: 0,
    };
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.total)
}

#[cfg(test)]
mod tests {
    #[test]
    fn nvidia_memory_above_four_gib_remains_available_for_recommendation() {
        let devices = super::parse_nvidia("NVIDIA Fixture GPU, 32768, 24576, 580.00\n");
        assert_eq!(devices[0]["vramBytes"], 32768_u64 * 1024 * 1024);
        assert_eq!(devices[0]["freeVramBytes"], 24576_u64 * 1024 * 1024);
    }
}
