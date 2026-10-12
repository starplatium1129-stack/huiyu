use serde_json::{Value, json};
#[cfg(windows)]
use std::time::Duration;

pub(super) async fn local_hardware() -> Value {

    #[cfg(windows)]
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
    #[cfg(not(windows))]
    {
        json!({"ramBytes":null,"devices":[]})
    }
}

#[cfg(windows)]
fn parse_nvidia(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let values: Vec<_> = line.split(',').map(str::trim).collect();
        if values.len() != 4 { return None; }
        let mib = |value: &str| value.parse::<u64>().ok().and_then(|n| n.checked_mul(1024 * 1024));
        Some(json!({"name":values[0],"type":"cuda","vramBytes":mib(values[1]),"freeVramBytes":mib(values[2]),"driverVersion":values[3]}))
    }).collect()
}

#[cfg(windows)]
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
