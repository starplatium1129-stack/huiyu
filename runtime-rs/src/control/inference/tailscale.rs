use serde_json::Value;
use std::process::Stdio;

pub(super) async fn tailscale_drawing_address(local_port: u16) -> Option<String> {
    use std::net::{IpAddr, SocketAddr};

    let (network, serving) = tokio::join!(
        tailscale_json(&["status", "--json", "--peers=false"]),
        tailscale_json(&["serve", "status", "--json"]),
    );
    let network = network?;
    if network["BackendState"] != "Running" {
        return None;
    }
    let ip = network["Self"]["TailscaleIPs"]
        .as_array()?
        .iter()
        .filter_map(|value| value.as_str()?.parse::<IpAddr>().ok())
        .min_by_key(|ip| !ip.is_ipv4())?;
    let serving = serving?;
    let loopback = format!("127.0.0.1:{local_port}");
    let localhost = format!("localhost:{local_port}");
    let port = serving["TCP"]
        .as_object()?
        .iter()
        .filter_map(|(port, handler)| {
            let target = handler["TCPForward"].as_str()?;
            if (target != loopback && target != localhost)
                || handler["TerminateTLS"]
                    .as_str()
                    .is_some_and(|host| !host.is_empty())
            {
                return None;
            }
            port.parse::<u16>().ok().filter(|port| *port != 0)
        })
        .min_by_key(|port| (*port != local_port, *port))?;
    Some(format!("http://{}", SocketAddr::new(ip, port)))
}

async fn tailscale_json(args: &[&str]) -> Option<Value> {
    use tokio::process::Command;

    #[cfg(windows)]
    let mut command = {
        let programs =
            std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles"))?;
        let mut command =
            Command::new(std::path::PathBuf::from(programs).join("Tailscale/tailscale.exe"));
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("tailscale");

    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(2), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}
