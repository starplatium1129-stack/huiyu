use super::{Error, Result, Value, config::Context, fs, json};
use std::path::PathBuf;
pub(super) struct Lock {
    target: PathBuf,
    token: String,
}
impl Lock {
    pub fn release(&self) -> Result<()> {
        if let Some(value) = fs::json(&self.target, true, true)?
            && value["token"] == self.token
        {
            std::fs::remove_file(&self.target)?;
            fs::sync(self.target.parent().unwrap())?;
        }
        Ok(())
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
fn alive(owner: &Value) -> Result<bool> {
    let pid = super::number(&owner["pid"])
        .filter(|pid| *pid > 0)
        .ok_or_else(|| Error::new("LOCK_UNCERTAIN", "Owner PID unknown"))?;
    let token = owner["token"].as_str().unwrap_or("");
    if owner["host"] != fs::hostname()?
        || token.len() != 36
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(Error::new(
            "LOCK_UNCERTAIN",
            "Lock owner cannot be established",
        ));
    }
    Ok(crate::processes::liveness(pid) != "dead")
}
pub(super) fn acquire(ctx: &Context, name: &str, depth: u8) -> Result<Lock> {
    if depth > 8 {
        return Err(Error::new(
            "LOCK_UNCERTAIN",
            "Too many interrupted recoveries",
        ));
    }
    let target = fs::child(&ctx.store, &format!("locks/{name}.json"))?;
    let token = uuid::Uuid::new_v4().to_string();
    let owner = json!({"pid":std::process::id(),"host":fs::hostname()?,"token":token});
    let claim = ctx.store.join("locks").join(format!("claim-{token}.json"));
    fs::write_json(&claim, &owner)?;
    let result = (|| {
        for _ in 0..4 {
            fs::safe(&target, true, true)?;
            match std::fs::hard_link(&claim, &target) {
                Ok(()) => {
                    fs::sync(target.parent().unwrap())?;
                    return Ok(Lock {
                        target: target.clone(),
                        token: token.clone(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            let Some(old) = fs::json(&target, true, true)? else {
                continue;
            };
            if alive(&old)? {
                return Err(Error::new("BUSY", "Another resource operation active"));
            }
            let _reaper = acquire(
                ctx,
                &format!("reap-{}", old["token"].as_str().unwrap()),
                depth + 1,
            )?;
            if let Some(now) = fs::json(&target, true, true)?
                && now["token"] == old["token"]
                && !alive(&now)?
            {
                std::fs::remove_file(&target)?;
            }
        }
        Err(Error::new("BUSY", "Resource lock changed during recovery"))
    })();
    if fs::safe(&claim, true, true)?.is_some() {
        std::fs::remove_file(&claim)?;
    }
    result
}
