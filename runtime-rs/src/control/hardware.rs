use serde_json::{Value, json};
#[cfg(windows)]
use std::time::Duration;

pub(super) async fn local_hardware() -> Value {
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new("nvidia-smi.exe");
        command
            .args([
                "--query-gpu=name,memory.total,memory.free,driver_version,compute_cap",
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
        let other_devices = if devices.is_empty() {
            display_adapters().await
        } else {
            Vec::new()
        };
        let mut value = json!({"ramBytes":system_ram(),"devices":null,"otherDevices":null,"windowsBuild":windows_build()});
        value["devices"] = Value::Array(devices);
        value["otherDevices"] = Value::Array(other_devices);
        value
    }
    #[cfg(not(windows))]
    {
        json!({"ramBytes":null,"devices":[]})
    }
}

#[cfg(windows)]
async fn display_adapters() -> Vec<Value> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $huiyuAdapters=@(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI*' } | Select-Object Name,DriverVersion); ConvertTo-Json -InputObject $huiyuAdapters -Compress"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .creation_flags(0x08000000).kill_on_drop(true);
    let query = async {
        let mut child = command.spawn().ok()?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()?
            .take(65537)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > 65536 || !child.wait().await.ok()?.success() {
            return None;
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        Some(
            value
                .as_array()?
                .iter()
                .filter_map(|device| {
                    let name = device["Name"].as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(json!({"name":name,"driverVersion":device["DriverVersion"].as_str()}))
                })
                .collect::<Vec<_>>(),
        )
    };
    tokio::time::timeout(Duration::from_secs(4), query)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(version: *mut Version) -> i32;
    }
    let mut version = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service: [0; 128],
    };
    (unsafe { RtlGetVersion(&mut version) } == 0).then_some(version.build)
}

#[cfg(windows)]
fn parse_nvidia(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let mut values = line.split(',').map(str::trim);
        let (name, total, free, driver, compute) = (
            values.next()?, values.next()?, values.next()?, values.next()?, values.next()?,
        );
        if values.next().is_some() { return None; }
        let mib = |value: &str| value.parse::<u64>().ok().and_then(|n| n.checked_mul(1024 * 1024));
        Some(json!({"name":name,"type":"cuda","vramBytes":mib(total),"freeVramBytes":mib(free),"driverVersion":driver,"computeCapability":compute}))
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
