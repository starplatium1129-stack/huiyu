use super::*;

impl Catalog {
    // All supported edits append history in the same transaction as their payload.
    // The kind/sequence index makes each dependency lookup a bounded index seek.
    pub(super) fn kind_stamp(&self, kind: &str) -> Result<i64> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM content_history WHERE kind=?1",
            [kind],
            |row| row.get(0),
        )?)
    }

    pub(super) fn projection_stamp(&self, name: &str) -> Result<Vec<i64>> {
        let kinds: &[&str] = match name {
            "characters.json" => &["character"],
            "popular-characters.json" => &["character", "outfit"],
            "scene-blueprints.json" => &["blueprint"],
            "scenes.json"
            | "scenes-nene.json"
            | "scenes-natsume.json"
            | "scenes-shared.json"
            | "scenes-core.json"
            | "scenes-index.json" => &["scene"],
            _ => &[],
        };
        let mut stamps = kinds
            .iter()
            .map(|kind| self.kind_stamp(kind))
            .collect::<Result<Vec<_>>>()?;
        if name == "tags-dictionary.json" {
            for id in ["tags", "tag-dictionary-policy"] {
                stamps.push(self.connection.query_row(
                    "SELECT revision FROM content_records WHERE kind='document' AND id=?1 AND deleted=0",
                    [id], |row| row.get(0),
                ).optional()?.unwrap_or(0));
            }
            return Ok(stamps);
        }
        let document = match name {
            "scenes.json"
            | "scenes-nene.json"
            | "scenes-natsume.json"
            | "scenes-shared.json"
            | "scenes-core.json"
            | "scenes-index.json" => Some("curation"),
            "curation.json"
            | "tags.json"
            | "loras.json"
            | "prompt-pinned-scenes.json"
            | "retired-scenes.json" => name.strip_suffix(".json"),
            _ => None,
        };
        if let Some(id) = document {
            // Document revisions are independent; editing tags cannot expire scenes.
            stamps.push(self.connection.query_row(
                "SELECT revision FROM content_records WHERE kind='document' AND id=?1 AND deleted=0",
                [id], |row| row.get(0),
            ).optional()?.unwrap_or(0));
        }
        Ok(stamps)
    }
}
