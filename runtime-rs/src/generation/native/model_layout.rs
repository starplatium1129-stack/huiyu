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
    let root = root
        .canonicalize()
        .map_err(|_| "模型目录不存在或不可读".to_owned())?;
    let index = ["modular_model_index.json", "model_index.json"]
        .into_iter()
        .find(|name| file(&root, &root.join(name)))
        .ok_or("缺少 Anima 模型索引")?;
    let index = json(&root.join(index))?;
    if index["_class_name"] != "AnimaModularPipeline"
        || index
            .get("_blocks_class_name")
            .is_some_and(|v| v != "AnimaAutoBlocks")
    {
        return Err("模型索引不是支持的 AnimaModularPipeline".into());
    }
    for (name, library, classes) in COMPONENTS {
        let folder = root.join(name);
        if !folder.is_dir() || linked(&folder) {
            return Err(format!("缺少可读取的组件目录：{name}"));
        }
        let entry = index[name]
            .as_array()
            .ok_or_else(|| format!("索引缺少组件：{name}"))?;
        if !matches!(entry.len(), 2 | 3)
            || entry[0] != library
            || !entry[1]
                .as_str()
                .is_some_and(|class| classes.contains(&class))
        {
            return Err(format!("不支持的组件类型：{name}"));
        }
        match name {
            "tokenizer" | "t5_tokenizer" => {
                let config = json(&folder.join("tokenizer_config.json"))?;
                safe_config(&config, name)?;
                if config.get("tokenizer_class").is_some_and(|class| {
                    !class.as_str().is_some_and(|class| classes.contains(&class))
                }) {
                    return Err(format!("不支持的 tokenizer 类型：{name}"));
                }
                let assets = file(&root, &folder.join("tokenizer.json"))
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
            "scheduler" => {
                let config = json(&folder.join("scheduler_config.json"))?;
                if config["_class_name"] != "FlowMatchEulerDiscreteScheduler"
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
                if !entries.iter().any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|value| value == "safetensors")
                        && file(&root, &entry.path())
                }) {
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
