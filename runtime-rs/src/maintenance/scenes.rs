mod products;
use super::{Result, fs, prompt, state};
pub(crate) use products::build as scene_products;
pub(super) use products::sync_version;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
fn sorted(mut values: Vec<Value>) -> Vec<Value> {
    values.sort_by_key(|value| {
        state::scene_number(value["id"].as_str().unwrap_or("")).unwrap_or(u64::MAX)
    });
    values
}
