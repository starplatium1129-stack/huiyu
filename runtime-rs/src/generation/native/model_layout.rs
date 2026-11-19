use serde_json::Value;
use std::{collections::HashSet, fs, io::Read, path::Path};

const COMPONENTS: [(&str, &str, &[&str]); 7] = [
    ("text_encoder", "transformers", &["Qwen3Model"]),
    ("text_conditioner", "diffusers", &["AnimaTextConditioner"]),
    ("transformer", "diffusers", &["CosmosTransformer3DModel"]),
    ("vae", "diffusers", &["AutoencoderKLQwenImage"]),
    (
        "tokenizer",
        "transformers",
        &["Qwen2Tokenizer", "Qwen2TokenizerFast"],
    ),
    (
        "t5_tokenizer",
        "transformers",
        &["T5Tokenizer", "T5TokenizerFast"],
    ),
    (
        "scheduler",
        "diffusers",
        &["FlowMatchEulerDiscreteScheduler"],
    ),
];

/// Bounded local layout inspection, not tensor/GPU compatibility or hash proof.
/// Keep model discovery and request admission on the same component contract.
pub(crate) fn model_issue(root: &Path) -> Option<String> {
    inspect(root).err()
}

fn inspect(root: &Path) -> Result<(), String> {
    inspect_model(root, None)
}
pub(super) fn inspect_adapter(root: &Path, model: &Value) -> Result<(), String> {
    inspect_model(root, Some(model))
}
pub(super) fn inspect_managed_bundle(root: &Path, id: &str) -> Result<(), String> {
    static CATALOG: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../../tools/inference/managed-adapter-models.json"))
            .expect("bundled model assets")
    });
    let root = root.canonicalize().map_err(|_| "模型目录不可读")?;
    let files = CATALOG["models"].as_array().and_then(|items| items.iter().find(|item| item["id"] == id))
        .and_then(|item| item["files"].as_array()).filter(|files| !files.is_empty()).ok_or("模型文件清单缺失")?;
    for asset in files {
        let name = asset["path"].as_str().ok_or("无效的模型文件清单")?;
        let path = root.join(name);
        if !file(&root, &path) || fs::metadata(&path).ok().map(|meta| meta.len()) != asset["bytes"].as_u64() {
            return Err(format!("缺少完整模型文件：{name}"));
        }
    }
    Ok(())
}
fn inspect_model(root: &Path, model: Option<&Value>) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|_| "模型目录不存在或不可读".to_owned())?;
    let indexes: &[&str] = if model.is_some_and(|m| m["indexFile"] == "modular_model_index.json") {
        &["modular_model_index.json"]
    } else if model.is_some() {
        &["model_index.json"]
    } else {
        &["modular_model_index.json", "model_index.json"]
    };
    let index = indexes
        .iter()
        .copied()
        .find(|name| file(&root, &root.join(name)))
        .ok_or("缺少完整 Diffusers 模型索引")?;
    let index = json(&root.join(index))?;
    let adapter_components;
    let components = if let Some(model) = model {
        let class = model["pipeline"].as_str().ok_or("模型适配声明无效")?;
        if index["_class_name"] != class {
            return Err(format!(
                "需要 {class} 完整目录，不能使用 Comfy 分片或其他模型目录"
            ));
        }
        safe_config(&index, "model_index")?;
        let layout = model["layout"].as_str().unwrap_or(class);
        let manifest = super::adapters::manifest();
        if let Some(fields) = manifest["variantFields"][layout].as_object() {
            for (field, source) in fields {
                let source = source.as_str().ok_or("模型变体声明无效")?;
                if !same_index_value(&index[field], &model[source]) {
                    return Err(format!("{class} 索引字段 {field} 与所选模型变体不匹配"));
                }
            }
        }
        if class == "WanPipeline"
            && model["layout"] != "WanA14B"
            && (index["expand_timesteps"] != true
                || !index["boundary_ratio"].is_null()
                || index
                    .get("transformer_2")
                    .is_some_and(|v| v != &serde_json::json!([null, null])))
        {
            return Err("需要 Wan 2.2 TI2V 5B 单模型配置".into());
        }
        if model["layout"] == "WanA14B" && index.get("expand_timesteps").is_some_and(|v| v != false)
        {
            return Err("需要 Wan A14B T2V 双噪声模型与 0.875 分界配置".into());
        }
        if let Some(blocks) = model.get("blocks")
            && index["_blocks_class_name"] != *blocks
        {
            return Err(format!("{class} 模块化索引的 blocks 配置不匹配"));
        }
        adapter_components = manifest["layouts"][layout]
            .as_object()
            .ok_or("未知原生管线")?
            .iter()
            .map(|(name, spec)| {
                (
                    name.as_str(),
                    spec[0].as_str().unwrap(),
                    spec.as_array().unwrap()[1..]
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();
        adapter_components
            .iter()
            .map(|(n, l, c)| (*n, *l, c.as_slice()))
            .collect::<Vec<_>>()
    } else {
        if index["_class_name"] != "AnimaModularPipeline"
            || index
                .get("_blocks_class_name")
                .is_some_and(|v| v != "AnimaAutoBlocks")
        {
            return Err("模型索引不是支持的 AnimaModularPipeline".into());
        }
        COMPONENTS.to_vec()
    };
    for (name, library, classes) in components {
        let folder = root.join(name);
        if !folder.is_dir() || linked(&folder) {
            return Err(format!("缺少可读取的组件目录：{name}"));
        }
        let entry = index[name]
            .as_array()
            .ok_or_else(|| format!("索引缺少组件：{name}"))?;
        if (model.is_some_and(|m| m.get("blocks").is_none()) && entry.len() != 2)
            || !matches!(entry.len(), 2 | 3)
            || entry[0] != library
            || !entry[1]
                .as_str()
                .is_some_and(|class| classes.contains(&class))
        {
            return Err(format!("不支持的组件类型：{name}"));
        }
        let qwen_processor = name == "tokenizer" && entry[1] == "Qwen2_5_VLProcessor";
        match name {
            _ if name == "processor" || qwen_processor => {
                let combined = folder.join("processor_config.json");
                let config = if combined.exists() {
                    let value = json(&combined)?;
                    safe_config(&value, name)?;
                    match value.get("image_processor") {
                        Some(image) if image.is_object() => image.clone(),
                        Some(_) => return Err("无效的嵌套图像处理器配置".into()),
                        None => json(&folder.join("preprocessor_config.json"))?,
                    }
                } else {
                    json(&folder.join("preprocessor_config.json"))?
                };
                safe_config(&config, name)?;
                let tokenizer = json(&folder.join("tokenizer_config.json"))?;
                safe_config(&tokenizer, name)?;
                if qwen_processor && (tokenizer["tokenizer_class"] != "Qwen2Tokenizer"
                    || tokenizer["processor_class"] != entry[1]) {
                    return Err("Kandinsky 分词器或图像处理器类型不匹配".into());
                }
                let legacy = folder.join("chat_template.json");
                let template = if legacy.exists() || linked(&legacy) {
                    let config = json(&legacy)?;
                    safe_config(&config, "chat_template")?;
                    let extra = folder.join("chat_templates");
                    let has_extra = extra.is_dir()
                        && fs::read_dir(extra)
                            .map_err(|_| "无法读取 processor 模板目录")?
                            .filter_map(Result::ok)
                            .any(|entry| {
                                entry
                                    .path()
                                    .extension()
                                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jinja"))
                            });
                    config["chat_template"]
                        .as_str()
                        .is_some_and(|value| !value.trim().is_empty())
                        && !has_extra
                } else {
                    file(&root, &folder.join("chat_template.jinja"))
                };
                if !file(&root, &folder.join("tokenizer.json")) || !template {
                    return Err("缺少 processor 的 tokenizer.json 或对应 chat_template".into());
                }
            }
            "tokenizer" | "t5_tokenizer" | "tokenizer_2" => {
                let config = json(&folder.join("tokenizer_config.json"))?;
                safe_config(&config, name)?;
                if config.get("tokenizer_class").is_some_and(|class| {
                    !class.as_str().is_some_and(|class| classes.contains(&class)
                        || entry[1].as_str().and_then(|c| c.strip_suffix("Fast")) == Some(class))
                }) {
                    return Err(format!("不支持的 tokenizer 类型：{name}"));
                }
                let assets = classes.contains(&"ByT5Tokenizer")
                    || file(&root, &folder.join("tokenizer.json"))
                    || (model.is_some()
                        && classes.iter().any(|c| c.starts_with("T5Tokenizer"))
                        && file(&root, &folder.join("spiece.model")))
                    || if name == "tokenizer" {
                        file(&root, &folder.join("vocab.json"))
                            && file(&root, &folder.join("merges.txt"))
                    } else {
                        file(&root, &folder.join("spiece.model"))
                    };
                if !assets {
                    return Err(format!("缺少 tokenizer 资源：{name}"));
                }
            }
            "scheduler" | "audio_scheduler" | "guider" => {
                let config = json(&folder.join(if name == "guider" {
                    "guider_config.json"
                } else {
                    "scheduler_config.json"
                }))?;
                if model.is_some() {
                    safe_config(&config, name)?;
                    check_component_config(model, name, &config)?;
                }
                if !config["_class_name"]
                    .as_str()
                    .is_some_and(|class| classes.contains(&class))
                    || config["stochastic_sampling"] == true
                {
                    return Err("不支持的 scheduler 配置".into());
                }
            }
            _ => {
                let config = json(&folder.join("config.json"))?;
                safe_config(&config, name)?;
                check_component_config(model, name, &config)?;
                if config.get("_class_name").is_some_and(|class| {
                    !class.as_str().is_some_and(|class| classes.contains(&class))
                }) {
                    return Err(format!("不支持的权重组件类型：{name}"));
                }
                let entries: Vec<_> = fs::read_dir(&folder)
                    .map_err(|_| format!("组件不可读：{name}"))?
                    .take(10001)
                    .collect::<Result<_, _>>()
                    .map_err(|_| format!("组件不可读：{name}"))?;
                if entries.len() > 10000 {
                    return Err(format!("组件文件过多：{name}"));
                }
                let has_weights = if model.is_some() {
                    let mut found = false;
                    // Match the adapter worker's glob, including Windows case
                    // handling. Every matching entry must be a safe weight file.
                    for entry in &entries {
                        let filename = entry.file_name();
                        let filename = filename.to_string_lossy();
                        if filename.ends_with(".safetensors")
                            || cfg!(windows)
                                && filename.to_ascii_lowercase().ends_with(".safetensors")
                        {
                            if !file(&root, &entry.path()) {
                                return Err(format!("空或不安全的模型权重：{name}/{filename}"));
                            }
                            found = true;
                        }
                    }
                    found
                } else {
                    // Anima retains its existing component contract: at least
                    // one safe nonempty weight, plus the shard-index checks.
                    entries.iter().any(|entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|value| value == "safetensors")
                            && file(&root, &entry.path())
                    })
                };
                if !has_weights {
                    return Err(format!("缺少非空 safetensors 权重：{name}"));
                }
                for entry in entries {
                    if !entry
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".safetensors.index.json")
                    {
                        continue;
                    }
                    let shards = json(&entry.path())?;
                    let mapping = shards["weight_map"]
                        .as_object()
                        .filter(|map| !map.is_empty())
                        .ok_or_else(|| format!("无效的分片索引：{name}"))?;
                    // Many tensors share one shard. Validate each name, but
                    // inspect each file only once within this index read.
                    let mut checked = HashSet::new();
                    for shard in mapping.values() {
                        let shard = shard
                            .as_str()
                            .ok_or_else(|| format!("无效的分片名称：{name}"))?;
                        if shard.contains(['/', '\\', ':', '\0'])
                            || !shard.ends_with(".safetensors")
                            || (checked.insert(shard) && !file(&root, &folder.join(shard)))
                        {
                            return Err(format!("缺少或无效的模型分片：{name}/{shard}"));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn check_component_config(model: Option<&Value>, name: &str, config: &Value) -> Result<(), String> {
    if let Some(fields) = model.and_then(|spec| spec["componentConfigs"][name].as_object()) {
        for (key, expected) in fields {
            if !config.get(key).is_some_and(|value| same_index_value(value, expected)) {
                return Err(format!("组件配置不符合所选模型：{name}/{key}"));
            }
        }
    }
    Ok(())
}

// JSON model indexes may serialize a whole-valued sigma as 1 or 1.0.
fn same_index_value(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_index_value(a, b))
        }
        (Value::Number(a), Value::Number(b)) if a.is_f64() || b.is_f64() => {
            a.as_f64() == b.as_f64()
        }
        _ => actual == expected,
    }
}

fn safe_config(value: &Value, name: &str) -> Result<(), String> {
    if [
        "auto_map",
        "quantization_config",
        "custom_pipeline",
        "trust_remote_code",
    ]
    .iter()
    .any(|key| value.get(key).is_some())
    {
        return Err(format!("不支持量化或自定义代码组件：{name}"));
    }
    Ok(())
}
fn linked(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
        }
        #[cfg(not(windows))]
        {
            meta.file_type().is_symlink()
        }
    })
}
fn file(root: &Path, path: &Path) -> bool {
    !linked(path)
        && path.canonicalize().is_ok_and(|path| path.starts_with(root))
        && fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}
fn json(path: &Path) -> Result<Value, String> {
    if linked(path) || !fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0) {
        return Err(format!("缺少非空配置文件：{}", path.display()));
    }
    let mut bytes = Vec::new();
    let limit = if path
        .file_name()
        .is_some_and(|name| name == "tokenizer_config.json")
    {
        2 * 1024 * 1024
    } else {
        1024 * 1024
    };
    fs::File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|_| format!("配置不可读：{}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!("配置文件过大：{}", path.display()));
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| format!("配置 JSON 无效：{}", path.display()))
}
