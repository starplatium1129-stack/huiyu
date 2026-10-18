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
        if class == "Krea2Pipeline" && index["is_distilled"] != model["distilled"] {
            return Err("Krea RAW/Turbo 的 is_distilled 与模型身份不匹配".into());
        }
        if class == "QwenImage21Pipeline"
            && index.get("sample_sigmas").filter(|v| !v.is_null()) != model.get("sampleSigmas")
        {
            return Err("Qwen 2.1 基础版/Turbo 的采样配置不匹配".into());
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
        if model["layout"] == "WanA14B"
            && (index["boundary_ratio"] != model["boundaryRatio"]
                || index.get("expand_timesteps").is_some_and(|v| v != false))
        {
            return Err("需要 Wan A14B T2V 双噪声模型与 0.875 分界配置".into());
        }
        if model
            .get("blocks")
            .is_some_and(|blocks| &index["_blocks_class_name"] != blocks)
        {
            return Err("需要官方 MiniMaxH3Blocks 模块化索引".into());
        }
        adapter_components = super::adapters::manifest()["layouts"]
            [model["layout"].as_str().unwrap_or(class)]
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
        match name {
            "processor" => {
                safe_config(&json(&folder.join("preprocessor_config.json"))?, name)?;
                safe_config(&json(&folder.join("tokenizer_config.json"))?, name)?;
                if !file(&root, &folder.join("tokenizer.json"))
                    || !file(
                        &root,
                        &folder.join(if model.is_some_and(|m| m.get("blocks").is_some()) {
                            "chat_template.json"
                        } else {
                            "chat_template.jinja"
                        }),
                    )
                {
                    return Err("缺少 processor 的 tokenizer.json 或对应 chat_template".into());
                }
            }
            "tokenizer" | "t5_tokenizer" | "tokenizer_2" => {
                let config = json(&folder.join("tokenizer_config.json"))?;
                safe_config(&config, name)?;
                if config.get("tokenizer_class").is_some_and(|class| {
                    !class.as_str().is_some_and(|class| classes.contains(&class))
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
                            || cfg!(windows) && filename.to_ascii_lowercase().ends_with(".safetensors")
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
                        entry.path().extension().is_some_and(|value| value == "safetensors")
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
    fs::File::open(path)
        .and_then(|file| file.take(1048577).read_to_end(&mut bytes))
        .map_err(|_| format!("配置不可读：{}", path.display()))?;
    if bytes.len() > 1048576 {
        return Err(format!("配置文件过大：{}", path.display()));
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| format!("配置 JSON 无效：{}", path.display()))
}
