use std::sync::{LockResult, Mutex, MutexGuard, Once, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub(crate) fn recover_lock_result<T>(result: LockResult<T>) -> T {
    static WARN: Once = Once::new();
    result.unwrap_or_else(|error| {
        WARN.call_once(|| eprintln!("[desktop] recovered a poisoned host lock"));
        error.into_inner()
    })
}

/// A poisoned lock retains memory safety. Recover the value so a renderer or
/// window callback panic cannot cascade across unrelated host operations.
pub(crate) trait RecoverMutex<T> {
    #[track_caller]
    fn recover_lock(&self) -> MutexGuard<'_, T>;
}

impl<T> RecoverMutex<T> for Mutex<T> {
    #[track_caller]
    fn recover_lock(&self) -> MutexGuard<'_, T> {
        recover_lock_result(self.lock())
    }
}

pub(crate) trait RecoverRwLock<T> {
    fn recover_read(&self) -> RwLockReadGuard<'_, T>;
    fn recover_write(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RecoverRwLock<T> for RwLock<T> {
    fn recover_read(&self) -> RwLockReadGuard<'_, T> {
        recover_lock_result(self.read())
    }

    fn recover_write(&self) -> RwLockWriteGuard<'_, T> {
        recover_lock_result(self.write())
    }
}
