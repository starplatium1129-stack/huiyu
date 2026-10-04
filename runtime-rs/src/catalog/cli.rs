use super::*;
pub fn run(args: &[String]) -> Result<Option<Value>> {
    if args.first().map(String::as_str) != Some("catalog") {
        return Ok(None);
    }
    if args.iter().any(|v| v == "--help") {
        println!(
            "huiyu-runtime catalog <stats|query|record|history|character|export|patch|import|check|colors> [--root <project>] --runtime-root <runtime>\nrecord/history: --kind <kind> --id <id> [--revision <number>]\ncharacter: --character <id> (complete revision-bearing record snapshot)\nexport: --out <directory> [--character <id> ...] [--record <kind:id> ...]; selected exports merge into existing snapshots\nquery: --kind <kind> [--character <id>] [--sort newest|updated|title|id|order] [--created-from <RFC3339>] [--created-to <RFC3339>] [--page <number>] [--page-size <number>]\npatch/import: --file <json> [--apply]; preview by default. patch JSON: {{changes:[{{kind,id,expectedRevision,patch|data,createdAt,sortOrder,remove}}]}}"
        );
        return Ok(Some(json!({"ok":true})));
    }
    let action = args.get(1).map(String::as_str).unwrap_or("stats");
    let mut flags = std::collections::HashMap::new();
    let mut scope = snapshots::Scope::default();
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
            "--id",
            "--revision",
            "--record",
            "--sort",
            "--page",
            "--page-size",
            "--created-from",
            "--created-to",
        ]
        .contains(&args[at].as_str())
        {
            return Err(ApiError::invalid("未知内容命令参数"));
        }
        let value = args
            .get(at + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| ApiError::invalid("内容命令参数缺少值"))?;
        if args[at] == "--record" {
            let (kind, id) = value
                .split_once(':')
                .ok_or_else(|| ApiError::invalid("--record 使用 kind:id"))?;
            scope.records.push((kind.into(), id.into()));
        } else if args[at] == "--character" && action == "export" {
            scope.characters.push(value.clone());
        } else if flags.insert(args[at].as_str(), value).is_some() {
            return Err(ApiError::invalid("重复内容命令参数"));
        }
        at += 2;
    }
    let absolute = |flag: &str| -> Result<PathBuf> {
        if flag == "--root" && !flags.contains_key(flag) {
            return Ok(std::env::current_dir()?);
        }
        let value = flags
            .get(flag)
            .ok_or_else(|| ApiError::invalid(format!("缺少 {flag}")))?;
        Ok(std::path::absolute(value)?)
    };
    let mut catalog = Catalog::open(Options {
        source: absolute("--root")?,
        database: absolute("--runtime-root")?.join("content/catalog.sqlite"),
    })?;
    let required = |flag: &str| -> Result<&str> {
        flags
            .get(flag)
            .map(|s| s.as_str())
            .ok_or_else(|| ApiError::invalid(format!("缺少 {flag}")))
    };
    let number = |flag: &str| -> Result<Option<i64>> {
        flags
            .get(flag)
            .map(|s| {
                s.parse::<i64>()
                    .map_err(|_| ApiError::invalid(format!("{flag} 需要整数")))
            })
            .transpose()
    };
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
            sort: flags
                .get("--sort")
                .map(|s| (*s).clone())
                .unwrap_or_default(),
            created_from: flags
                .get("--created-from")
                .map(|s| (*s).clone())
                .unwrap_or_default(),
            created_to: flags
                .get("--created-to")
                .map(|s| (*s).clone())
                .unwrap_or_default(),
            page: number("--page")?,
            page_size: number("--page-size")?,
            ..Default::default()
        })?,
        "record" => json!({"ok":true,"record":if let Some(revision)=number("--revision")? {
            catalog.historical(required("--kind")?,required("--id")?,revision)?
        } else { catalog.get(required("--kind")?,required("--id")?)? }}),
        "history" => catalog.history(required("--kind")?, required("--id")?)?,
        "character" => catalog.snapshot_selected(&snapshots::Scope {
            characters: vec![required("--character")?.into()],
            records: vec![],
        })?,
        "export" => catalog.export_selected(&absolute("--out")?, &scope)?,
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
                "内容命令需要 stats、query、record、history、character、export、patch、import、check 或 colors",
            ));
        }
    };
    Ok(Some(result))
}
