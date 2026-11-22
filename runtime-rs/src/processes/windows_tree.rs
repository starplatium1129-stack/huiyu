//! An adapter can start an additional process that owns the GPU context.
//! Attach before sending the first job and wait for the whole tree on handoff.
use super::*;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};

pub(crate) struct WorkerTree(OwnedHandle);

impl OwnedProcess {
    pub(crate) fn own_worker_tree(&self) -> Result<WorkerTree> {
        let children = self.pool.children.lock().unwrap();
        let process = children
            .get(&self.id)
            .and_then(|e| e.child.raw_handle())
            .ok_or_else(termination_unconfirmed)?;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let tree = WorkerTree(OwnedHandle::from_raw_handle(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, process) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(tree)
        }
    }
}

impl WorkerTree {
    fn active(&self) -> Result<u32> {
        let mut facts = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                &mut facts as *mut _ as _,
                std::mem::size_of_val(&facts) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(termination_unconfirmed());
        }
        Ok(facts.ActiveProcesses)
    }

    pub(crate) async fn retire(&self) -> Result<()> {
        if self.active()? == 0 {
            return Ok(());
        }
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 && self.active()? > 0 {
            return Err(termination_unconfirmed());
        }
        tokio::time::timeout(Duration::from_secs(6), async {
            while self.active()? != 0 {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| termination_unconfirmed())?
    }
}
