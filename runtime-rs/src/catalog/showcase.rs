use super::*;

impl Catalog {
    pub(crate) fn showcase_source(
        &self,
        id: &str,
        matches_source: impl Fn(Option<&Value>, Option<&Value>) -> bool,
    ) -> Result<Option<(Record, Option<Record>)>> {
        let transaction = self.connection.unchecked_transaction()?;
        // The upload ID may be a combined blueprint alias longer than either
        // record key. Legacy seeds also preserve payload IDs verbatim, so select
        // by the original payload rather than imposing a record-key limit.
        let scene = self
            .connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM content_records WHERE kind='scene' AND deleted=0 AND json_type(payload,'$.id')='text' AND json_extract(payload,'$.id')=?1 ORDER BY sort_order,id LIMIT 1"),
                [id],
                row,
            )
            .optional()?;
        if let Some(scene) = scene {
            transaction.commit()?;
            return Ok(Some((scene, None)));
        }
        // Match both spellings in the original order using only identity fields.
        // Full trees and unrelated image/prompt bodies never enter the Rust heap.
        let blueprint_key = {
            let mut statement = self.connection.prepare(
                "SELECT id,payload->'$.id',payload->'$.characterId' FROM content_records WHERE kind='blueprint' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let mut selected = None;
            for value in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, field(row, 1)?, field(row, 2)?))
            })? {
                let (key, id, character) = value?;
                if matches_source(id.as_ref(), character.as_ref()) {
                    selected = Some(key);
                    break;
                }
            }
            selected
        };
        let Some(blueprint_key) = blueprint_key else {
            transaction.commit()?;
            return Ok(None);
        };
        let blueprint = self.get("blueprint", &blueprint_key)?;
        let character_key = {
            let mut statement = self.connection.prepare(
                "SELECT id,payload->'$.popular.id' FROM content_records WHERE kind='character' AND deleted=0 AND json_type(payload,'$.popular') IS NOT NULL ORDER BY sort_order,id",
            )?;
            let mut selected = None;
            for value in
                statement.query_map([], |row| Ok((row.get::<_, String>(0)?, field(row, 1)?)))?
            {
                let (key, id) = value?;
                if id.unwrap_or_default() == blueprint.data["characterId"] {
                    selected = Some(key);
                    break;
                }
            }
            selected
        };
        let character = character_key
            .as_deref()
            .map(|id| self.get("character", id))
            .transpose()?;
        transaction.commit()?;
        Ok(Some((blueprint, character)))
    }
}

fn field(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = row.get(index)?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}
