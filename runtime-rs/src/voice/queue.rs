use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(super) struct Queue {
    name: &'static str,
    serial: Arc<Semaphore>,
    slots: Arc<Semaphore>,
}
pub(super) struct Reservation {
    _slot: OwnedSemaphorePermit,
    entered: Instant,
}
pub(super) struct Permit {
    _reservation: Reservation,
    _serial: OwnedSemaphorePermit,
    pub wait_ms: u128,
}
impl Queue {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            serial: Arc::new(Semaphore::new(1)),
            slots: Arc::new(Semaphore::new(16)),
        }
    }
    pub fn reserve(&self) -> Result<Reservation> {
        self.slots
            .clone()
            .try_acquire_owned()
            .map(|slot| Reservation {
                _slot: slot,
                entered: Instant::now(),
            })
            .map_err(|_| ApiError::new(503, "QUEUE_FULL", "语音队列繁忙"))
    }
    pub async fn enter(
        &self,
        reservation: Reservation,
        cancel: &CancellationToken,
    ) -> Result<Permit> {
        let serial = tokio::select! {
            result = self.serial.clone().acquire_owned() => result.map_err(|_| cancelled())?,
            _ = cancel.cancelled() => return Err(cancelled()),
        };
        Ok(Permit {
            wait_ms: reservation.entered.elapsed().as_millis(),
            _reservation: reservation,
            _serial: serial,
        })
    }
    pub fn status(&self) -> Value {
        let active = 1 - self.serial.available_permits();
        json!({"name": self.name, "active": active, "pending": (16 - self.slots.available_permits()).saturating_sub(active), "maxPending": 16})
    }
}
pub(super) fn cancelled() -> ApiError {
    ApiError::new(503, "ABORTED", "语音服务已关闭")
}
