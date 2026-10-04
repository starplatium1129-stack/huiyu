use super::*;
pub fn run(args: &[String]) -> Result<Option<Value>> {
    if args.first().map(String::as_str) != Some("catalog") {
        return Ok(None);
    }
    if args.iter().any(|v| v == "--help") {
        println!(
            "huiyu-runtime catalog <stats|query|export|patch|import|check|colors> --root <project> --runtime-root <runtime> [--out <snapshot-directory>] [--file <json>] [--apply]\npatch/import preview by default; patch JSON: {{changes:[{{kind,id,expectedRevision,data,sortOrder,remove}}]}}"
        );
        return Ok(Some(json!({"ok":true})));
    }
    let action = args.get(1).map(String::as_str).unwrap_or("stats");
    let mut flags = std::collections::HashMap::new();
    let mut apply = false;
    let mut at = 2;
    while at < args.len() {
        if args[at] == "--apply" {
            apply = true;
            at += 1;
            continue;
        }
        if ![
            "--root",
            "--runtime-root",
            "--out",
            "--file",
            "--kind",
            "--character",
            "--search",
        ]
        .contains(&args[at].as_str())
        {
            return Err(ApiError::invalid("未知内容命令参数"));
        }
        let value = args
            .get(at + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| ApiError::invalid("内容命令参数缺少值"))?;
        if flags.insert(args[at].as_str(), value).is_some() {
            return Err(ApiError::invalid("重复内容命令参数"));
        }
        at += 2;
    }
    let absolute = |flag: &str| -> Result<PathBuf> {
        let value = flags
            .get(flag)
            .ok_or_else(|| ApiError::invalid(format!("缺少 {flag}")))?;
        Ok(std::path::absolute(value)?)
    };
    let mut catalog = Catalog::open(Options {
        source: absolute("--root")?,
        database: absolute("--runtime-root")?.join("content/catalog.sqlite"),
    })?;
    let result = match action {
        "stats" => catalog.stats()?,
        "check" => catalog.check()?,
        "colors" => Ok::<_, ApiError>(
            json!({"ok":true,"output":crate::maintenance::colors::report(&catalog.options.source,&tokio_util::sync::CancellationToken::new()).map_err(|e|ApiError::invalid(e.message))?}),
        )?,
        "query" => catalog.query(&Query {
            kind: flags
                .get("--kind")
                .map(|s| (*s).clone())
                .unwrap_or("scene".into()),
            character: flags
                .get("--character")
                .map(|s| (*s).clone())
                .unwrap_or_default(),
            search: flags
                .get("--search")
                .map(|s| (*s).clone())
                .unwrap_or_default(),
            ..Default::default()
        })?,
        "export" => catalog.export(&absolute("--out")?)?,
        "patch" => {
            let value: Value = serde_json::from_slice(&std::fs::read(absolute("--file")?)?)?;
            let changes: Vec<Change> = serde_json::from_value(value["changes"].clone())?;
            catalog.apply(&changes, !apply)?
        }
        "import" => catalog.import(
            &serde_json::from_slice(&std::fs::read(absolute("--file")?)?)?,
            !apply,
        )?,
        _ => {
            return Err(ApiError::invalid(
                "内容命令需要 stats、query、export、patch、import、check 或 colors",
            ));
        }
    };
    Ok(Some(result))
}
