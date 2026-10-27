use super::*;
pub fn run(args: &[String]) -> Result<Option<Value>> {
    if args.first().map(String::as_str) != Some("catalog") {
        return Ok(None);
    }
    if args.iter().any(|v| v == "--help") {
        println!(
            "huiyu-runtime catalog <stats|query|record|history|character|authoring|export|patch|import|check|colors> [--root <content source>] [--seed-root <bundled defaults>] --runtime-root <runtime>\nrecord/history: --kind <kind> --id <id> [--revision <number>]\ncharacter: --character <id> (complete revision-bearing record snapshot)\nauthoring: --character <existing id> returns compact revision-bearing context; --character <new id> --example <existing id> marks a new target with a reference; --kind scene [--id <existing scene>] returns scene context or next scene ID and pin protection\nexport: --out <directory> [--character <id> ...] [--record <kind:id> ...]; an existing destination requires a scope and known ancestry; full backups use a new directory\nquery: --kind <kind> [--character <id>] [--sort newest|updated|title|id|order] [--created-from <RFC3339>] [--created-to <RFC3339>] [--page <number>] [--page-size <number>]\npatch/import: --file <json> [--apply]; preview by default. patch JSON: {{changes:[{{kind,id,expectedRevision,patch|data,createdAt,sortOrder,remove}}]}}\nimport only: --preserve-local keeps complete locally modified records and accepts incoming seeds; reports preservedLocal. Older upstream snapshots and conflicting imports are rejected. stats and CLI receipts identify the actual database."
        );
        return Ok(Some(json!({"ok":true})));
    }
    let action = args.get(1).map(String::as_str).unwrap_or("stats");
    let mut flags = std::collections::HashMap::new();
    let mut scope = snapshots::Scope::default();
    let mut apply = false;
    let mut preserve_local = false;
    let mut at = 2;
    while at < args.len() {
        if args[at] == "--preserve-local" {
            if action != "import" || preserve_local {
                return Err(ApiError::invalid(
                    "--preserve-local 仅用于 import，且不能重复",
                ));
            }
            preserve_local = true;
            at += 1;
            continue;
        }
        if args[at] == "--apply" {
            apply = true;
            at += 1;
            continue;
        }
        if ![
            "--root",
            "--seed-root",
            "--runtime-root",
            "--out",
            "--file",
            "--kind",
            "--character",
            "--example",
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
        seed_source: flags
            .contains_key("--seed-root")
            .then(|| absolute("--seed-root"))
            .transpose()?,
        database: absolute("--runtime-root")?.join("content/catalog.sqlite"),
    })?;
    if action == "authoring" && apply || action != "authoring" && flags.contains_key("--example") {
        return Err(ApiError::invalid(
            "authoring 只读，--example 仅用于 authoring",
        ));
    }
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
    let mut result = match action {
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
        "record" => {
            let record = if let Some(revision) = number("--revision")? {
                catalog.historical(required("--kind")?, required("--id")?, revision)?
            } else {
                catalog.get(required("--kind")?, required("--id")?)?
            };
            let mut value = json!({"ok":true,"record":null});
            value["record"] = record.into_value()?;
            value
        }
        "history" => catalog.history(required("--kind")?, required("--id")?)?,
        "character" => catalog.snapshot_selected(&snapshots::Scope {
            characters: vec![required("--character")?.into()],
            records: vec![],
        })?,
        "authoring" => match flags
            .get("--kind")
            .map(|value| value.as_str())
            .unwrap_or("character")
        {
            "character" if !flags.contains_key("--id") => catalog.authoring_context(
                required("--character")?,
                flags.get("--example").map(|value| value.as_str()),
            )?,
            "scene" if !flags.contains_key("--character") && !flags.contains_key("--example") => {
                catalog.scene_authoring_context(flags.get("--id").map(|value| value.as_str()))?
            }
            _ => {
                return Err(ApiError::invalid(
                    "authoring 请使用 --character <ID> [--example <ID>] 或 --kind scene [--id <ID>]",
                ));
            }
        },
        "export" => catalog.export_selected(&absolute("--out")?, &scope)?,
        "patch" => {
            let mut value: Value = serde_json::from_slice(&std::fs::read(absolute("--file")?)?)?;
            let changes: Vec<Change> = serde_json::from_value(
                value
                    .get_mut("changes")
                    .map(Value::take)
                    .unwrap_or_default(),
            )?;
            catalog.apply(&changes, !apply)?
        }
        "import" => catalog.import_with_policy(
            &serde_json::from_slice(&std::fs::read(absolute("--file")?)?)?,
            !apply,
            preserve_local,
        )?,
        _ => {
            return Err(ApiError::invalid(
                "内容命令需要 stats、query、record、history、character、authoring、export、patch、import、check 或 colors",
            ));
        }
    };
    result["source"] = catalog.source_info();
    Ok(Some(result))
}
