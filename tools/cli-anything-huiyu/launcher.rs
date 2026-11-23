use std::{
    env, io,
    process::{self, Command, ExitStatus},
};

fn launch() -> io::Result<ExitStatus> {
    let executable = env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("缺少命令行目录"))?;
    // Pass arguments directly so shell punctuation in prompts remains text.
    Command::new(directory.join("../../qq-sdk/node.exe"))
        .arg(directory.join("cli.mjs"))
        .args(env::args_os().skip(1))
        .status()
}

fn main() {
    match launch() {
        Ok(status) => process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("无法启动绘遇命令行，请核对桌面安装目录：{error}");
            process::exit(1);
        }
    }
}
