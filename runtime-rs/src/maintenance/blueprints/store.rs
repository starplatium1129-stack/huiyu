use super::*;
struct Baseline {
    file: PathBuf,
    bytes: Option<Vec<u8>>,
}
struct Sources {
    manifest: Value,
    shards: serde_json::Map<String, Value>,
    rows: Vec<Value>,
    baseline: Vec<Baseline>,
}
fn json(bytes: &[u8], label: &str) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|_| {
        Error::new(
            400,
            "BLUEPRINT_SOURCE_INVALID",
            format!("{label} 不是合法 JSON"),
        )
    })
}
fn read_sources(root: &Path, folder: &str, field: &str, empty: bool) -> Result<Sources> {
    fs::safe(root, true, false)?;
    fs::safe(&root.join("data"), true, false)?;
    let directory = root.join("data").join(folder);
    fs::safe(&directory, true, false)?;
    let file = directory.join("manifest.json");
    let bytes = fs::read(&file, false)?.unwrap();
    let manifest = json(&bytes, &format!("{folder}/manifest.json"))?;
    let entries = manifest["files"]
        .as_array()
        .filter(|items| empty || !items.is_empty())
        .ok_or_else(|| {
            Error::new(
                400,
                "BLUEPRINT_SOURCE_INVALID",
                format!("data/{folder}/manifest.json 必须声明非空 files 数组"),
            )
        })?;
    let mut baseline = vec![Baseline {
        file,
        bytes: Some(bytes),
    }];
    let (mut rows, mut shards, mut names) = (Vec::new(), serde_json::Map::new(), HashSet::new());
    for entry in entries {
        let name = entry["file"]
            .as_str()
            .filter(|name| safe_name(name))
            .ok_or_else(|| Error::path("分片文件名不安全"))?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(Error::path("分片文件名在 Windows 大小写不敏感下重复"));
        }
        let file = directory.join(name);
        let bytes = fs::read(&file, false)?.unwrap();
        let data = json(&bytes, name)?;
        let text =
            String::from_utf8(bytes.clone()).map_err(|_| Error::invalid("分片文本不是 UTF-8"))?;
        rows.extend(
            data[field]
                .as_array()
                .ok_or_else(|| Error::invalid(format!("{name} 根必须含 {field} 数组")))?
                .iter()
                .cloned(),
        );
        shards.insert(name.into(), json!({"text":text,"data":data}));
        baseline.push(Baseline {
            file,
            bytes: Some(bytes),
        });
    }
    Ok(Sources {
        manifest,
        shards,
        rows,
        baseline,
    })
}
pub fn load(root: &Path) -> Result<Vec<Value>> {
    let root = fs::absolute(root)?;
    Ok(read_sources(&root, "blueprints", "blueprints", false)?.rows)
}
pub(crate) fn load_popular(root: &Path) -> Result<Vec<Value>> {
    Ok(read_sources(&fs::absolute(root)?, "popular", "characters", false)?.rows)
}
pub fn aggregate_is_current(root: &Path) -> Result<bool> {
    let root = fs::absolute(root)?;
    let current = fs::read(&root.join("data/scene-blueprints.json"), true)?;
    let expected = json_text(&json!({"version":2,"blueprints":load(&root)?}));
    Ok(current.as_deref() == Some(expected.as_bytes()))
}

/// Opaque, host-owned prepared state. Unlike a deserialized request, it retains
/// the original bytes of every source, including unchanged shards and ownership.
pub struct Prepared {
    root: PathBuf,
    plan: Value,
    targets: Vec<PathBuf>,
    baseline: Vec<Baseline>,
    writes: Vec<(PathBuf, Vec<u8>)>,
    deletes: Vec<PathBuf>,
    manifest_write: Option<Vec<u8>>,
    aggregate_write: Option<Vec<u8>>,
}
impl Prepared {
    pub fn plan(&self) -> &Value {
        &self.plan
    }
    pub fn targets(&self) -> Vec<PathBuf> {
        self.targets.clone()
    }
    pub fn apply(&self, transaction: &Transaction) -> Result<()> {
        for baseline in &self.baseline {
            if fs::read(&baseline.file, true)? != baseline.bytes {
                return Err(Error::conflict(format!(
                    "蓝图准备状态已过期：{} 的原始字节或存在状态发生变化",
                    baseline
                        .file
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                )));
            }
        }
        for (file, bytes) in &self.writes {
            transaction.write(file, bytes)?;
        }
        for file in &self.deletes {
            transaction.remove(file)?;
        }
        let manifest = self.root.join("data/blueprints/manifest.json");
        let aggregate = self.root.join("data/scene-blueprints.json");
        if let Some(bytes) = &self.manifest_write {
            transaction.write(&manifest, bytes)?;
        }
        if let Some(bytes) = &self.aggregate_write {
            transaction.write(&aggregate, bytes)?;
        }
        for (file, bytes) in self
            .writes
            .iter()
            .map(|(file, bytes)| (file, bytes))
            .chain(self.manifest_write.iter().map(|bytes| (&manifest, bytes)))
            .chain(self.aggregate_write.iter().map(|bytes| (&aggregate, bytes)))
        {
            if fs::read(file, false)?.as_deref() != Some(bytes.as_slice()) {
                return Err(Error::conflict("蓝图写回核验失败"));
            }
        }
        for file in &self.deletes {
            if fs::safe(file, false, true)?.is_some() {
                return Err(Error::conflict("蓝图计划删除的来源分片仍存在"));
            }
        }
        Ok(())
    }
}
pub fn prepare(options: &Options, incoming: &[Value], previous: &[Value]) -> Result<Prepared> {
    let root = fs::absolute(&options.root)?;
    let mut sources = read_sources(&root, "blueprints", "blueprints", true)?;
    if !same(&json!(sources.rows), &json!(previous)) {
        return Err(Error::conflict(
            "蓝图当前源分片与读取基线不一致；请重新读取",
        ));
    }
    let popular = read_sources(&root, "popular", "characters", false)?;
    let mut characters = HashMap::new();
    let mut mapping = serde_json::Map::new();
    for character in &popular.rows {
        let id = character["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| Error::invalid("热门角色身份无效"))?;
        if characters.insert(id, character).is_some() {
            return Err(Error::invalid(format!("热门角色身份重复：{id}")));
        }
        mapping.insert(id.into(), character["franchise"].clone());
    }
    let old = previous
        .iter()
        .filter_map(|bp| bp["id"].as_str().map(|id| (id, bp)))
        .collect::<HashMap<_, _>>();
    for blueprint in incoming {
        if old
            .get(blueprint["id"].as_str().unwrap_or(""))
            .is_some_and(|old| {
                binding_equal(old.get("characterId"), blueprint.get("characterId"))
                    && binding_equal(old.get("outfitId"), blueprint.get("outfitId"))
            })
        {
            continue;
        }
        if match &blueprint["outfitId"] {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::String(value) => !value.is_empty(),
            Value::Number(value) => value.as_f64() != Some(0.),
            _ => true,
        } {
            let character = blueprint["characterId"]
                .as_str()
                .and_then(|id| characters.get(id));
            if character
                .and_then(|c| c["outfits"].as_array())
                .is_none_or(|outfits| {
                    !outfits
                        .iter()
                        .any(|outfit| binding_equal(outfit.get("id"), blueprint.get("outfitId")))
                })
            {
                return Err(Error::invalid(format!(
                    "蓝图 {} 的服装不属于所选角色：{}",
                    blueprint["id"].as_str().unwrap_or(""),
                    blueprint["outfitId"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| js(&blueprint["outfitId"]))
                )));
            }
        }
    }
    let plan = planner::plan(
        &json!({"manifest":sources.manifest,"shards":sources.shards,"blueprints":incoming,"franchiseByCharacter":mapping}),
    )?;
    let manifest = root.join("data/blueprints/manifest.json");
    let aggregate = root.join("data/scene-blueprints.json");
    let aggregate_bytes = fs::read(&aggregate, true)?;
    let mut targets = vec![manifest, aggregate.clone()];
    sources.baseline.push(Baseline {
        file: aggregate.clone(),
        bytes: aggregate_bytes.clone(),
    });
    let mut writes = Vec::new();
    let mut deletes = Vec::new();
    for write in plan["writes"].as_array().unwrap() {
        let file = root
            .join("data/blueprints")
            .join(write["file"].as_str().unwrap());
        if write["kind"] == "create" {
            let bytes = fs::read(&file, true)?;
            if bytes.is_some() {
                return Err(Error::conflict(
                    "新蓝图分片路径已被未登记文件占用，拒绝覆盖",
                ));
            }
            sources.baseline.push(Baseline {
                file: file.clone(),
                bytes: None,
            });
        }
        targets.push(file.clone());
        writes.push((file, write["text"].as_str().unwrap().as_bytes().to_vec()));
    }
    for deleted in plan["deletes"].as_array().unwrap() {
        let file = root
            .join("data/blueprints")
            .join(deleted["file"].as_str().unwrap());
        targets.push(file.clone());
        deletes.push(file);
    }
    sources.baseline.extend(popular.baseline);
    let manifest_write = (plan["manifest"]["changed"] == true).then(|| {
        plan["manifest"]["text"]
            .as_str()
            .unwrap()
            .as_bytes()
            .to_vec()
    });
    let text = plan["aggregate"]["text"]
        .as_str()
        .unwrap()
        .as_bytes()
        .to_vec();
    let aggregate_write = (aggregate_bytes.as_ref() != Some(&text)).then_some(text);
    Ok(Prepared {
        root,
        plan,
        targets,
        baseline: sources.baseline,
        writes,
        deletes,
        manifest_write,
        aggregate_write,
    })
}
fn binding_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a), Some(b)) if !a.is_object() && !a.is_array() => a == b,
        _ => false,
    }
}
