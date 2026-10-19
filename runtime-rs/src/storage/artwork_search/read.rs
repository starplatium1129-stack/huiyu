use super::*;

const BUDGET: usize = 128;

#[derive(Clone)]
struct NumericCursor {
    time: f64,
    key: String,
}

#[derive(PartialEq, Eq)]
enum Phase {
    Candidates,
    Small,
    Numeric,
    Legacy,
}

// The awaiting request owns this state between FIFO turns. No SQLite statement,
// transaction or workspace-global search entry survives a yield/cancellation.
pub(in crate::storage) struct Search {
    terms: Vec<String>,
    cursor: Option<String>,
    revision: Option<i64>,
    phase: Phase,
    candidates: Vec<i64>,
    numeric_after: Option<NumericCursor>,
    legacy_after: String,
    numeric: Vec<Value>,
    legacy: Vec<Value>,
    last_match: String,
}

pub(in crate::storage) enum Step {
    Continue(Search),
    Complete(Value),
}

enum Window {
    NumericStart,
    NumericSame(NumericCursor),
    NumericLower(f64),
    Legacy,
}

#[derive(PartialEq, Eq)]
enum ScanEnd {
    Exhausted,
    Yield,
    Filled,
}

impl Search {
    pub(in crate::storage) fn new(command: &Value) -> Result<Self> {
        let terms = command["terms"]
            .as_array()
            .ok_or_else(|| invalid("Search terms must be an array"))?
            .iter()
            .map(|term| {
                term.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("Search terms must be strings"))
            })
            .collect::<Result<Vec<_>>>()?;
        if terms.is_empty() || terms.iter().any(String::is_empty) {
            return Err(invalid("Search terms must not be empty"));
        }
        let cursor = command
            .get("cursor")
            .map(|cursor| {
                cursor
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("Invalid search cursor"))
            })
            .transpose()?;
        Ok(Self {
            terms,
            legacy_after: cursor.clone().unwrap_or_default(),
            cursor,
            revision: None,
            phase: Phase::Candidates,
            candidates: Vec::new(),
            numeric_after: None,
            numeric: Vec::new(),
            legacy: Vec::new(),
            last_match: String::new(),
        })
    }

    pub(in crate::storage) fn step(mut self, c: &Context) -> Result<Step> {
        c.check_cancel()?;
        let revision = artwork_index::revision(c)?;
        if self.revision != Some(revision) {
            // A writer may change ordering, text or deletion state between turns.
            // Restart from the caller's public cursor, never combine revisions.
            self.revision = Some(revision);
            self.phase = Phase::Candidates;
            self.candidates.clear();
            self.numeric_after = None;
            self.legacy_after = self.cursor.clone().unwrap_or_default();
            self.numeric.clear();
            self.legacy.clear();
            self.last_match.clear();
        }
        if self.phase == Phase::Candidates {
            self.phase = if self.cursor.is_none() {
                Phase::Numeric
            } else {
                Phase::Legacy
            };
            if ready(c)? {
                if let Some(ids) = self.candidate_ids(c)? {
                    self.candidates = ids;
                    self.phase = Phase::Small;
                }
                // The bounded FTS probe used this turn's candidate budget.
                return Ok(Step::Continue(self));
            }
        }
        if self.phase == Phase::Small {
            let items = self.small_candidates(c)?;
            c.check_cancel()?;
            return Ok(Step::Complete(self.response(items, None)));
        }

        let mut budget = BUDGET;
        if self.phase == Phase::Numeric {
            let end = if let Some(after) = self.numeric_after.clone() {
                let time = after.time;
                let end = self.scan(c, Window::NumericSame(after), &mut budget)?;
                if end == ScanEnd::Exhausted && budget > 0 {
                    self.scan(c, Window::NumericLower(time), &mut budget)?
                } else {
                    end
                }
            } else {
                self.scan(c, Window::NumericStart, &mut budget)?
            };
            if end != ScanEnd::Yield {
                self.phase = Phase::Legacy;
            }
        }
        if self.phase == Phase::Legacy && budget > 0 {
            match self.scan(c, Window::Legacy, &mut budget)? {
                ScanEnd::Filled => {
                    let cursor = std::mem::take(&mut self.last_match);
                    return Ok(Step::Complete(self.finish(Some(cursor))));
                }
                ScanEnd::Exhausted => return Ok(Step::Complete(self.finish(None))),
                ScanEnd::Yield => {}
            }
        }
        c.check_cancel()?;
        Ok(Step::Continue(self))
    }

    fn scan(&mut self, c: &Context, window: Window, budget: &mut usize) -> Result<ScanEnd> {
        let numeric = !matches!(window, Window::Legacy);
        // Split the mixed DESC/ASC continuation into two range seeks. A single
        // OR predicate can rescan a huge equal-timestamp prefix on every turn.
        let sql = match &window {
            Window::NumericStart => {
                "SELECT numeric_time,id_key,search_text,summary FROM artwork_read_index INDEXED BY artwork_read_numeric WHERE numeric_time IS NOT NULL ORDER BY numeric_time DESC,id_key LIMIT ?1"
            }
            Window::NumericSame(_) => {
                "SELECT numeric_time,id_key,search_text,summary FROM artwork_read_index INDEXED BY artwork_read_numeric WHERE numeric_time IS NOT NULL AND numeric_time=?1 AND id_key>?2 ORDER BY id_key LIMIT ?3"
            }
            Window::NumericLower(_) => {
                "SELECT numeric_time,id_key,search_text,summary FROM artwork_read_index INDEXED BY artwork_read_numeric WHERE numeric_time IS NOT NULL AND numeric_time<?1 ORDER BY numeric_time DESC,id_key LIMIT ?2"
            }
            Window::Legacy => {
                "SELECT numeric_time,id_key,search_text,summary FROM artwork_read_index INDEXED BY artwork_read_legacy WHERE numeric_time IS NULL AND id_key>?1 ORDER BY id_key LIMIT ?2"
            }
        };
        let limit = *budget;
        let mut statement = c.db.prepare_cached(sql)?;
        let mut rows = match &window {
            Window::NumericStart => statement.query([limit as i64])?,
            Window::NumericSame(after) => {
                statement.query(params![after.time, after.key, limit as i64])?
            }
            Window::NumericLower(time) => statement.query(params![time, limit as i64])?,
            Window::Legacy => statement.query(params![self.legacy_after, limit as i64])?,
        };
        let mut examined = 0;
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            examined += 1;
            *budget -= 1;
            let key = text_column(row, 1)?;
            // Advance even for misses; the public legacy cursor still names the
            // last returned match, so its 201st match remains on the next page.
            if numeric {
                let time = row.get(0)?;
                let after = self.numeric_after.get_or_insert_with(|| NumericCursor {
                    time,
                    key: String::new(),
                });
                after.time = time;
                after.key.clear();
                after.key.push_str(key);
            } else {
                self.legacy_after.clear();
                self.legacy_after.push_str(key);
            }
            if self.matches(text_column(row, 2)?) {
                if numeric {
                    self.numeric
                        .push(serde_json::from_str(text_column(row, 3)?)?);
                    if self.numeric.len() == 5 {
                        return Ok(ScanEnd::Filled);
                    }
                } else {
                    if self.legacy.len() == 200 {
                        return Ok(ScanEnd::Filled);
                    }
                    self.legacy
                        .push(serde_json::from_str(text_column(row, 3)?)?);
                    self.last_match.clear();
                    self.last_match.push_str(&self.legacy_after);
                }
            }
        }
        Ok(if examined < limit {
            ScanEnd::Exhausted
        } else {
            ScanEnd::Yield
        })
    }

    fn matches(&self, text: &str) -> bool {
        self.terms.iter().all(|term| text.contains(term.as_str()))
    }

    fn candidate_ids(&self, c: &Context) -> Result<Option<Vec<i64>>> {
        let (table, pattern) = anchor(&self.terms);
        // FTS emits rowids directly: no ORDER BY, IN subquery or total count
        // can materialize its full posting list. A full probe falls back to the
        // bounded ordered scan, even if its final result has exactly BUDGET IDs.
        let mut statement = c.db.prepare_cached(&format!(
            "SELECT rowid FROM {table} WHERE {table} MATCH ?1 LIMIT {BUDGET}"
        ))?;
        let mut rows = statement.query([pattern])?;
        let mut ids = Vec::new();
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            ids.push(row.get::<_, i64>(0)?);
            if ids.len() == BUDGET {
                return Ok(None);
            }
        }
        Ok(Some(ids))
    }

    fn small_candidates(&self, c: &Context) -> Result<Vec<Value>> {
        let mut source = c.db.prepare_cached(
            "SELECT numeric_time,id_key,search_text,summary FROM artwork_read_index WHERE rowid=?",
        )?;
        let mut numeric = Vec::new();
        let mut legacy = Vec::new();
        for id in &self.candidates {
            c.check_cancel()?;
            let mut rows = source.query([id])?;
            if let Some(row) = rows.next()? {
                let time = row.get::<_, Option<f64>>(0)?;
                let key = text_column(row, 1)?;
                if time.is_some() && self.cursor.is_some()
                    || time.is_none() && key <= self.cursor.as_deref().unwrap_or("")
                    || !self.matches(text_column(row, 2)?)
                {
                    continue;
                }
                let summary: Value = serde_json::from_str(text_column(row, 3)?)?;
                if let Some(time) = time {
                    numeric.push((time, key.to_owned(), summary));
                } else {
                    legacy.push((key.to_owned(), summary));
                }
            }
        }
        // At most 127 rows reach these sorts. Numeric times were filtered to
        // finite values when deriving the index; equal times retain key order.
        numeric.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then_with(|| a.1.cmp(&b.1)));
        legacy.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(numeric
            .into_iter()
            .take(5)
            .map(|(_, _, summary)| summary)
            .chain(legacy.into_iter().map(|(_, summary)| summary))
            .collect())
    }

    fn finish(mut self, cursor: Option<String>) -> Value {
        let mut items = std::mem::take(&mut self.numeric);
        items.append(&mut self.legacy);
        self.response(items, cursor)
    }

    fn response(&self, items: Vec<Value>, cursor: Option<String>) -> Value {
        let mut result = json!({"items":null,"artworkRevision":self.revision,"nextCursor":null});
        result["items"] = items.into();
        result["nextCursor"] = cursor.map(Value::String).unwrap_or(Value::Null);
        result
    }
}
