use super::*;

pub(super) struct Artwork {
    pub key: String,
    pub revision: i64,
    pub deleted_at: Option<i64>,
    pub references: Vec<Reference>,
}
impl Artwork {
    pub fn capture(c: &Context, input: &Value) -> Result<Self> {
        let key = entity_key(&input["id"])?;
        let (revision, deleted_at) = artwork_state(c, &key)?;
        if input["expectedRevision"] != revision {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Artwork has a newer revision",
            ));
        }
        Ok(Self {
            references: references(c, &key)?,
            key,
            revision,
            deleted_at,
        })
    }
    pub fn check_before(&self, c: &Context) -> Result<()> {
        if artwork_state(c, &self.key)? != (self.revision, self.deleted_at) {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Artwork has a newer revision",
            ));
        }
        if references(c, &self.key)? != self.references {
            return Err(conflict(
                "MEDIA_INVALID",
                "Artwork media references changed",
            ));
        }
        Ok(())
    }
    pub fn check_files(&self, c: &Context, verified: &Verification) -> Result<()> {
        for reference in &self.references {
            c.check_cancel()?;
            let path = media::object_path(&c.root, &reference.hash)?;
            let proof = verified
                .files
                .get(&reference.hash)
                .filter(|proof| proof.matches(&path, &reference.metadata()))
                .ok_or_else(|| {
                    conflict(
                        "MEDIA_INVALID",
                        "Artwork media verification is incomplete or changed",
                    )
                })?;
            proof.check(&c.root)?;
        }
        Ok(())
    }
    pub fn check_after(&self, c: &Context, revision: i64) -> Result<()> {
        let expected_revision = if self.deleted_at.is_some() {
            revision
        } else {
            self.revision
        };
        if artwork_state(c, &self.key)? != (expected_revision, None) {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Artwork changed during restoration",
            ));
        }
        let mut expected_refs = self.references.clone();
        if self.deleted_at.is_some() {
            for reference in &mut expected_refs {
                reference.owner_kind = "artwork".into();
            }
            expected_refs.sort_by(|left, right| left.hash.cmp(&right.hash));
        }
        if references(c, &self.key)? != expected_refs {
            return Err(conflict(
                "MEDIA_INVALID",
                "Artwork media references changed during restoration",
            ));
        }
        Ok(())
    }
}
