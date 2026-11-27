//! Comfy jobs have no PEFT worker. Check the requested A/B pairs against the
//! selected checkpoint's matrix shapes before submitting its loader graph.
use super::*;
use std::{collections::HashMap, io::Read};

type Targets = HashMap<String, (String, [u64; 2])>;

fn invalid(detail: impl std::fmt::Display) -> ApiError {
    error(
        "KREA_STYLE_LORA_INVALID",
        format!("Krea 2 风格文件或底模结构无效：{detail}"),
    )
}

fn read(path: &Path) -> Result<(serde_json::Map<String, Value>, u64)> {
    let mut file = fs::File::open(path).map_err(|_| invalid("无法打开权重"))?;
    let total = file
        .metadata()
        .map_err(|_| invalid("无法读取文件大小"))?
        .len();
    let mut prefix = [0u8; 8];
    file.read_exact(&mut prefix)
        .map_err(|_| invalid("文件头不完整"))?;
    let size = u64::from_le_bytes(prefix);
    if !(2..=16 * 1024 * 1024).contains(&size) || size + 8 > total {
        return Err(invalid("safetensors 头部长度不正确"));
    }
    let mut bytes = vec![0; size as usize];
    file.read_exact(&mut bytes)
        .map_err(|_| invalid("无法读取 safetensors 头部"))?;
    let header = serde_json::from_slice(&bytes).map_err(|_| invalid("safetensors 头部不是对象"))?;
    Ok((header, total - size - 8))
}

fn bare(name: &str) -> &str {
    let name = name.strip_prefix("base_model.model.").unwrap_or(name);
    let name = name
        .strip_prefix("model.diffusion_model.")
        .or_else(|| name.strip_prefix("diffusion_model."))
        .unwrap_or(name);
    name.strip_prefix("transformer.").unwrap_or(name)
}

fn diffusers_name(name: &str) -> String {
    match name {
        "first" => "img_in".into(),
        "last.linear" => "final_layer.linear".into(),
        "tmlp.0" => "time_embed.linear_1".into(),
        "tmlp.2" => "time_embed.linear_2".into(),
        "tproj.1" => "time_mod_proj".into(),
        "txtmlp.1" => "txt_in.linear_1".into(),
        "txtmlp.3" => "txt_in.linear_2".into(),
        "txtfusion.projector" => "text_fusion.projector".into(),
        _ => {
            let path = if let Some(path) = name.strip_prefix("blocks.") {
                format!("transformer_blocks.{path}")
            } else if let Some(path) = name.strip_prefix("txtfusion.") {
                format!("text_fusion.{path}")
            } else {
                return name.into();
            };
            for (side, converted) in [
                (".attn.wq", ".attn.to_q"),
                (".attn.wk", ".attn.to_k"),
                (".attn.wv", ".attn.to_v"),
                (".attn.wo", ".attn.to_out.0"),
                (".attn.gate", ".attn.to_gate"),
                (".mlp.up", ".ff.up"),
                (".mlp.down", ".ff.down"),
                (".mlp.gate", ".ff.gate"),
            ] {
                if let Some(block) = path.strip_suffix(side) {
                    return format!("{block}{converted}");
                }
            }
            path
        }
    }
}

pub(super) fn targets(path: &Path) -> Result<Targets> {
    let (header, _) = read(path)?;
    let mut targets = Targets::new();
    for (key, tensor) in header {
        let Some(raw) = key.strip_suffix(".weight").map(bare) else {
            continue;
        };
        let Ok(shape) = serde_json::from_value::<[u64; 2]>(tensor["shape"].clone()) else {
            continue;
        };
        let mapped = diffusers_name(raw);
        for name in [raw, mapped.as_str()] {
            for alias in [
                name.to_owned(),
                format!("lora_unet_{}", name.replace('.', "_")),
            ] {
                if let Some((prior, _)) = targets.insert(alias, (raw.into(), shape))
                    && prior != raw
                {
                    return Err(invalid("底模中的投影名称重复"));
                }
            }
        }
    }
    if targets.is_empty() {
        return Err(invalid("底模缺少线性层"));
    }
    Ok(targets)
}

pub(super) fn validate(path: &Path, targets: &Targets) -> Result<()> {
    let (mut header, data_len) = read(path)?;
    if let Some(meta) = header.remove("__metadata__")
        && let Some(config) = meta["lora_adapter_metadata"].as_str()
    {
        let config: Value =
            serde_json::from_str(config).map_err(|_| invalid("无效的 LoRA 配置"))?;
        if config.get("transformer.use_dora") == Some(&Value::Bool(true)) {
            return Err(invalid("不支持 DoRA 权重"));
        }
    }
    let mut pairs: HashMap<&str, [Option<u64>; 3]> = HashMap::new();
    let mut spans = Vec::with_capacity(header.len());
    for (key, tensor) in &header {
        let (target, side) = [
            (".lora_A.weight", 0),
            (".lora_down.weight", 0),
            (".lora_B.weight", 1),
            (".lora_up.weight", 1),
            (".alpha", 2),
        ]
        .iter()
        .find_map(|(suffix, side)| key.strip_suffix(suffix).map(|t| (bare(t), *side)))
        .ok_or_else(|| invalid(format!("不支持的权重 {key}")))?;
        let (canonical, [output, input]) = targets
            .get(target)
            .ok_or_else(|| invalid(format!("底模缺少 {target}")))?;
        let shape: Vec<u64> =
            serde_json::from_value(tensor["shape"].clone()).map_err(|_| invalid(key))?;
        let rank = match (side, shape.as_slice()) {
            (0, [r, width]) if *r > 0 && width == input => *r,
            (1, [height, r]) if *r > 0 && height == output => *r,
            (2, [] | [1]) => 1,
            _ => return Err(invalid(format!("{target} 的矩阵尺寸与底模不符"))),
        };
        let width = match tensor["dtype"].as_str() {
            Some("F32") => 4,
            Some("F16" | "BF16") => 2,
            Some("F64") => 8,
            Some("I64" | "U64") if side == 2 => 8,
            Some("I32" | "U32") if side == 2 => 4,
            Some("I16" | "U16") if side == 2 => 2,
            Some("I8" | "U8") if side == 2 => 1,
            _ => return Err(invalid(format!("{key} 的数据类型不受支持"))),
        };
        let bytes = shape
            .iter()
            .try_fold(width, |n: u64, dim| n.checked_mul(*dim));
        let [start, end]: [u64; 2] =
            serde_json::from_value(tensor["data_offsets"].clone()).map_err(|_| invalid(key))?;
        if end > data_len || bytes.is_none() || end.checked_sub(start) != bytes {
            return Err(invalid(key));
        }
        spans.push((start, end));
        if pairs.entry(canonical.as_str()).or_default()[side]
            .replace(rank)
            .is_some()
        {
            return Err(invalid(format!("{target} 的矩阵重复")));
        }
    }
    if pairs.is_empty()
        || pairs
            .values()
            .any(|pair| pair[0].is_none() || pair[0] != pair[1])
    {
        return Err(invalid("A/B 矩阵缺失或秩不匹配"));
    }
    spans.sort_unstable();
    let mut offset = 0;
    for (start, end) in spans {
        if start != offset {
            return Err(invalid("权重数据不连续"));
        }
        offset = end;
    }
    if offset != data_len {
        return Err(invalid("权重数据长度不符"));
    }
    Ok(())
}
