use super::*;
use std::collections::VecDeque;

// Full detail/list exports hydrate only at the external boundary.
pub(in crate::storage) const BODY: &str = "json_set(record_json,'$.input',json((SELECT input FROM task_payloads p WHERE p.task_id=tasks.task_id)),'$.checkpoint',json((SELECT checkpoint FROM task_payloads p WHERE p.task_id=tasks.task_id)))";
const BUDGET: usize = 8 * 1024 * 1024;
#[derive(Clone)]
pub(in crate::storage) struct Cached {
    id: String,
    token: String,
    input: Arc<serde_json::Map<String, Value>>,
    checkpoint: Option<Arc<Value>>,
    input_bytes: usize,
    checkpoint_bytes: usize,
}
impl Cached { fn bytes(&self) -> usize { self.input_bytes + self.checkpoint_bytes } }
fn remember(c: &Context, value: Cached) {
    let mut cache = c.task_payloads.borrow_mut();
    cache.retain(|item| item.id != value.id);
    if value.bytes() > BUDGET { return; }
    while cache.len() >= 8 || cache.iter().map(Cached::bytes).sum::<usize>() + value.bytes() > BUDGET {
        cache.pop_front();
    }
    cache.push_back(value);
}
fn load(c: &Context, id: &str, token: &str) -> Result<Cached> {
    if let Some(value) = c.task_payloads.borrow().iter().find(|item| item.id == id && item.token == token) {
        return Ok(value.clone());
    }
    let (input, checkpoint): (String,String) = c.db.query_row("SELECT input,checkpoint FROM task_payloads WHERE task_id=? AND token=?",params![id,token],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let value = Cached { id:id.into(),token:token.into(),input_bytes:input.len(),checkpoint_bytes:checkpoint.len(),
        input:serde_json::from_str(&input)?,checkpoint:serde_json::from_str(&checkpoint)? };
    remember(c,value.clone());
    Ok(value)
}
pub(super) fn hydrate(c: &Context, task: &mut TaskRecord, token: &str) -> Result<()> {
    let value = load(c,&task.task_id,token)?;
    task.input = value.input;
    task.checkpoint = value.checkpoint;
    Ok(())
}
pub(super) fn persist(c: &Context, task: &TaskRecord) -> Result<()> {
    // Random persisted tokens prevent a rolled-back revision from identifying
    // another payload after the global revision number is reused.
    let token: Option<String> = c.db.query_row("SELECT token FROM task_payloads WHERE task_id=?",[&task.task_id],|r|r.get(0)).optional()?;
    let old = token.map(|token|load(c,&task.task_id,&token)).transpose()?;
    let input_changed = old.as_ref().is_none_or(|old| !Arc::ptr_eq(&old.input,&task.input) && old.input != task.input);
    let checkpoint_changed = old.as_ref().is_none_or(|old| match (&old.checkpoint,&task.checkpoint) {
        (Some(a),Some(b)) => !Arc::ptr_eq(a,b) && a != b,
        (None,None) => false,
        _ => true,
    });
    if !input_changed && !checkpoint_changed { return Ok(()); }
    let input = input_changed.then(|| serde_json::to_string(&task.input)).transpose()?;
    let checkpoint = checkpoint_changed.then(|| serde_json::to_string(&task.checkpoint)).transpose()?;
    let shots = task.checkpoint.as_ref().and_then(|v|v["shots"].as_array()).map(|v|v.len() as i64);
    let token = uuid::Uuid::new_v4().to_string();
    c.db.execute("INSERT INTO task_payloads VALUES(?1,COALESCE(?2,'{}'),COALESCE(?3,'null'),?4,?5)
        ON CONFLICT(task_id) DO UPDATE SET input=COALESCE(?2,task_payloads.input),checkpoint=COALESCE(?3,task_payloads.checkpoint),
        checkpoint_shots=CASE WHEN ?3 IS NULL THEN task_payloads.checkpoint_shots ELSE ?4 END,token=?5",
        params![task.task_id,input,checkpoint,shots,token])?;
    // The persisted token is consulted before every cache hit, including writes.
    let input_bytes = input.as_ref().map_or_else(||old.as_ref().map_or(0,|v|v.input_bytes),String::len);
    let checkpoint_bytes = checkpoint.as_ref().map_or_else(||old.as_ref().map_or(0,|v|v.checkpoint_bytes),String::len);
    remember(c,Cached { id:task.task_id.clone(),token,input:task.input.clone(),checkpoint:task.checkpoint.clone(),input_bytes,checkpoint_bytes });
    Ok(())
}
pub(super) fn hot(task: &mut TaskRecord) -> Result<String> {
    // Stored task text is not an idempotency fingerprint. Serialize borrowed
    // state directly, keeping canonical fingerprints at their existing boundary.
    let input = std::mem::take(&mut task.input);
    let checkpoint = task.checkpoint.take();
    let encoded = serde_json::to_string(&*task).map_err(Into::into);
    task.input = input;
    task.checkpoint = checkpoint;
    encoded
}
pub(in crate::storage) fn migrate(db: &Connection) -> Result<()> {
    let ids = db.prepare("SELECT task_id FROM tasks")?.query_map([],|r|r.get::<_,String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        let body: String = db.query_row("SELECT record_json FROM tasks WHERE task_id=?",[&id],|r|r.get(0))?;
        let mut task: TaskRecord = serde_json::from_str(&body)?;
        let shots = task.checkpoint.as_ref().and_then(|v|v["shots"].as_array()).map(|v|v.len() as i64);
        db.execute("INSERT INTO task_payloads VALUES(?,?,?,?,?)",params![id,serde_json::to_string(&task.input)?,serde_json::to_string(&task.checkpoint)?,shots,uuid::Uuid::new_v4().to_string()])?;
        db.execute("UPDATE tasks SET record_json=? WHERE task_id=?",params![hot(&mut task)?,id])?;
    }
    Ok(())
}

pub(in crate::storage) type Cache = VecDeque<Cached>;
