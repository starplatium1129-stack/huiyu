use super::*;

pub(crate) fn build(root: &Path, scenes: Vec<Value>) -> Vec<(&'static str, Value)> {
    let sorted = sorted(scenes);
    let mut groups = [Vec::new(), Vec::new(), Vec::new()];
    let mut seen = HashSet::new();
    for scene in &sorted {
        if seen.insert(prompt::text(&scene["id"])) {
            let index = match scene["char"].as_str() {
                Some("natsume") => 1,
                Some("triad") => 2,
                _ => 0,
            };
            groups[index].push(scene.clone());
        }
    }
    let curation = fs::json(&root.join("data/curation.json")).unwrap_or(json!({}));
    let core_ids = prompt::strings(&curation["personaCoreSceneIds"])
        .into_iter()
        .take(2000)
        .filter(|id| seen.contains(id))
        .collect::<Vec<_>>();
    let by_id = sorted
        .iter()
        .map(|scene| (scene["id"].as_str().unwrap(), scene))
        .collect::<HashMap<_, _>>();
    let core: Vec<Value> = core_ids
        .iter()
        .map(|id| by_id[id.as_str()].clone())
        .collect();
    let index = json!({"version":1,"total":sorted.len(),"shards":{"nene":{"file":"scenes-nene.json","count":groups[0].len()},"natsume":{"file":"scenes-natsume.json","count":groups[1].len()},"shared":{"file":"scenes-shared.json","count":groups[2].len()}},"tiers":{"core":core_ids},"orderedIds":sorted.iter().map(|scene|&scene["id"]).collect::<Vec<_>>()});
    let [nene, natsume, shared] = groups;
    vec![
        ("scenes.json", Value::Array(sorted)),
        ("scenes-nene.json", Value::Array(nene)),
        ("scenes-natsume.json", Value::Array(natsume)),
        ("scenes-shared.json", Value::Array(shared)),
        ("scenes-core.json", Value::Array(core)),
        ("scenes-index.json", index),
    ]
}
