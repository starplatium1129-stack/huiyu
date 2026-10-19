use super::*;
pub(crate) fn validate_items(items: &[Value]) -> Result<()> {
    if items.len() > 2000 {
        return Err(Error::invalid("蓝图 数据格式或数量超出限制"));
    }
    let mut ids = HashSet::new();
    for item in items {
        crate::maintenance::generated::validate(item, true)?;
        let id = item["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| Error::invalid("蓝图 ID 必须非空且唯一"))?;
        if !ids.insert(id) {
            return Err(Error::invalid(format!("蓝图 ID 必须非空且唯一：{id}")));
        }
        for field in ["characterId", "title"] {
            if item[field].as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err(Error::invalid(format!("蓝图缺少 {field}：{id}")));
            }
        }
        if !item["promptTokens"].is_array() || !item["negativeTokens"].is_array() {
            return Err(Error::invalid(format!(
                "蓝图 promptTokens/negativeTokens 必须为数组：{id}"
            )));
        }
        if !item["promptProse"].is_string() {
            return Err(Error::invalid(format!("蓝图缺少 promptProse：{id}")));
        }
    }
    Ok(())
}
