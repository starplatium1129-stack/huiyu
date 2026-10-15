use super::*;

pub(super) struct Selection {
    pub id: Value,
    pub artwork: Option<Artwork>,
    pub code: Option<String>,
}
pub(super) fn prepare(c: &Context, command: &Value) -> Result<Vec<Selection>> {
    let items = command["items"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 200)
        .ok_or_else(|| invalid("Restore batch must contain 1–200 artworks"))?;
    let mut seen = BTreeSet::new();
    let mut selected = Vec::with_capacity(items.len());
    for item in items {
        c.check_cancel()?;
        if item["expectedRevision"]
            .as_i64()
            .is_none_or(|revision| revision < 0)
            || !seen.insert(entity_key(&item["id"])?)
        {
            return Err(invalid("Invalid or duplicate restore batch item"));
        }
        let (artwork, code) = match Artwork::capture(c, item) {
            Ok(artwork) => (Some(artwork), None),
            Err(error) if matches!(error.code.as_str(), "NOT_FOUND" | "REVISION_CONFLICT") => {
                (None, Some(error.code))
            }
            Err(error) => return Err(error),
        };
        selected.push(Selection {
            id: item["id"].clone(),
            artwork,
            code,
        });
    }
    Ok(selected)
}
pub(super) fn commit(
    publication: &Publication,
    c: &mut Context,
    identity: &Identity,
    verified: &Verification,
) -> Result<Value> {
    c.transaction(|c| {
        identity.check(c)?;
        let (operation, previous) = c.start_operation(&publication.principal, &publication.command)?;
        if let Some(receipt) = previous { return Ok(receipt); }
        let revision = c.next_revision()?;
        let mut memberships = apply::Memberships::default();
        let mut results = Vec::with_capacity(publication.items.len());
        let mut accepted = Vec::new();
        for item in &publication.items {
            c.check_cancel()?;
            let mut result = json!({"id":item.id,"restored":false});
            let Some(artwork) = &item.artwork else {
                result["code"] = json!(item.code);
                results.push(result);
                continue;
            };
            let code = match artwork.check_before(c) {
                Ok(()) => artwork.references.iter().find_map(|reference| verified.failed.get(&reference.hash)).cloned(),
                Err(error) if matches!(error.code.as_str(), "NOT_FOUND" | "REVISION_CONFLICT" | "MEDIA_INVALID") => Some(error.code),
                Err(error) => return Err(error),
            };
            if let Some(code) = code {
                result["code"] = json!(code);
                results.push(result);
                continue;
            }
            // Once verification passed, any path/proof failure aborts the batch.
            // Never catch errors after touching either SQLite or membership state.
            artwork.check_files(c, verified)?;
            if artwork.deleted_at.is_some() {
                apply::restore(c, &artwork.key, revision, &mut memberships)?;
                result["restored"] = json!(true);
            }
            // The old single-item receipt decoded the row. Retain rejection of
            // malformed snapshot/id JSON without returning every large body.
            records::artwork(c, &artwork.key)?
                .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Artwork does not exist"))?;
            accepted.push(artwork);
            results.push(result);
        }
        memberships.flush(c, revision)?;
        let receipt = json!({"operationId":publication.command["operationId"],"kind":"restoreArtworks","revision":revision,"restoreResults":results});
        c.commit_operation(&operation, &receipt)?;
        for artwork in accepted {
            artwork.check_after(c, revision)?;
            artwork.check_files(c, verified)?;
        }
        identity.check(c)?;
        Ok(receipt)
    })
}
