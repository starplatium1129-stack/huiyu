use super::*;
use rusqlite::{OptionalExtension, params};

pub(super) struct Operation {
    pub key: String,
    pub kind: String,
    pub id: String,
    pub fingerprint: String,
    pub state: String,
    pub input: Value,
    pub receipt: Option<Value>,
    pub revision: Option<i64>,
}
impl Operation {
    pub fn check(&self, kind: &str, input: &Value) -> Result<()> {
        check_input(&self.kind, &self.fingerprint, &self.state, kind, input)
    }
    pub fn state(&self) -> Value {
        let mut value = json!({"operationId":self.id,"kind":self.kind,"state":self.state,"revision":self.revision});
        if let Some(receipt) = &self.receipt {
            value["receipt"] = receipt.clone();
        }
        value
    }
}
fn check_input(
    stored_kind: &str,
    fingerprint: &str,
    state: &str,
    kind: &str,
    input: &Value,
) -> Result<()> {
    if stored_kind != kind || fingerprint != canonical::fingerprint(input) {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Operation ID was already used with different input",
        ));
    }
    if state == "aborted" {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Operation was explicitly aborted",
        ));
    }
    Ok(())
}
impl Context {
    pub(super) fn operation(&self, principal: &str, id: &str) -> Result<Option<Operation>> {
        let row=self.db.prepare_cached("SELECT op_key,kind,operation_id,fingerprint,state,input_json,receipt_json,revision FROM operations WHERE principal_id=? AND operation_id=?")?
            .query_row(params![principal,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<i64>>(7)?))).optional()?;
        row.map(
            |(key, kind, id, fingerprint, state, input, receipt, revision)| {
                Ok(Operation {
                    key,
                    kind,
                    id,
                    fingerprint,
                    state,
                    input: serde_json::from_str(&input)?,
                    receipt: receipt.map(|s| serde_json::from_str(&s)).transpose()?,
                    revision,
                })
            },
        )
        .transpose()
    }
    pub(super) fn insert_operation(
        &self,
        principal: &str,
        id: &str,
        kind: &str,
        input: &Value,
    ) -> Result<String> {
        let key = canonical::digest(canonical::stringify(&json!([principal, kind, id])));
        // Profile writes and their receipts commit in one transaction; recovery
        // never consumes their prepared input. Keep the fingerprint and exact
        // historical receipt, without serializing/storing the whole value twice.
        // Media/artwork operations still need their original input for recovery.
        let stored_input = if matches!(
            kind,
            "profile.saveSetting"
                | "profile.saveChatRecord"
                | "profile.saveDraft"
                | "profile.resetChat"
        ) {
            "null".into()
        } else {
            canonical::stringify(input)
        };
        self.db.execute("INSERT INTO operations(op_key,principal_id,kind,operation_id,fingerprint,state,input_json) VALUES(?,?,?,?,?,'prepared',?)",params![key,principal,kind,id,canonical::fingerprint(input),stored_input])?;
        Ok(key)
    }
    pub(super) fn commit_operation(&self, key: &str, receipt: &Value) -> Result<()> {
        self.db.execute(
            "UPDATE operations SET state='committed',receipt_json=?,revision=? WHERE op_key=?",
            params![
                canonical::stringify(receipt),
                receipt["revision"].as_i64(),
                key
            ],
        )?;
        Ok(())
    }
    pub(super) fn operation_receipt(
        &self,
        principal: &str,
        command: &Value,
    ) -> Result<Option<(String, Option<Value>)>> {
        let id = string(command, "operationId")?;
        let kind = string(command, "kind")?;
        let mut statement = self.db.prepare_cached(
            "SELECT op_key,kind,fingerprint,state,receipt_json FROM operations WHERE principal_id=? AND operation_id=?",
        )?;
        let mut rows = statement.query(params![principal, id])?;
        if let Some(row) = rows.next()? {
            // Replay needs the fingerprint and receipt, never a second decoded
            // copy of the original draft/chat/organization command.
            check_input(
                text_column(row, 1)?,
                text_column(row, 2)?,
                text_column(row, 3)?,
                kind,
                command,
            )?;
            let receipt = if matches!(row.get_ref(4)?, rusqlite::types::ValueRef::Null) {
                None
            } else {
                Some(serde_json::from_str(text_column(row, 4)?)?)
            };
            return Ok(Some((row.get(0)?, receipt)));
        }
        Ok(None)
    }
    pub(super) fn start_operation(
        &self,
        principal: &str,
        command: &Value,
    ) -> Result<(String, Option<Value>)> {
        let id = string(command, "operationId")?;
        let kind = string(command, "kind")?;
        if let Some(previous) = self.operation_receipt(principal, command)? {
            return Ok(previous);
        }
        Ok((self.insert_operation(principal, id, kind, command)?, None))
    }
}
