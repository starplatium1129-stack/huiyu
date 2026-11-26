use std::sync::{Mutex, MutexGuard, Once};

/// A poisoned lock retains memory safety. Recover the value so a renderer or
/// window callback panic cannot cascade across unrelated host operations.
pub(crate) trait RecoverMutex<T> {
    #[track_caller]
    fn recover_lock(&self) -> MutexGuard<'_, T>;
}

impl<T> RecoverMutex<T> for Mutex<T> {
    #[track_caller]
    fn recover_lock(&self) -> MutexGuard<'_, T> {
        static WARN: Once = Once::new();
        self.lock().unwrap_or_else(|error| {
            WARN.call_once(|| eprintln!("[desktop] recovered a poisoned host mutex"));
            error.into_inner()
        })
    }
}
