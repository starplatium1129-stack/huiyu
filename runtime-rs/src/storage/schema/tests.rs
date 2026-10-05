use super::*;

#[test]
fn failed_initialization_preserves_replaced_lock() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(".workspace-owner.json");
    let pending = OwnerInitialization {
        path: &path,
        output: OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap(),
        committed: false,
    };
    let original = directory.path().join("original");
    fs::rename(&path, &original).unwrap();
    fs::write(&path, b"replacement owner").unwrap();
    drop(pending);
    assert_eq!(fs::read(&path).unwrap(), b"replacement owner");

    #[cfg(unix)]
    {
        fs::remove_file(&path).unwrap();
        let pending = OwnerInitialization {
            path: &path,
            output: OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .unwrap(),
            committed: false,
        };
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&original, &path).unwrap();
        drop(pending);
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    }
}

#[cfg(unix)]
#[test]
fn failed_owner_initialization_can_retry_without_unlocking_existing_owner() {
    const CHILD: &str = "HUIYU_TEST_OWNER_WRITE_FAILURE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "storage::schema::tests::failed_owner_initialization_can_retry_without_unlocking_existing_owner", "--nocapture"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    // Isolate the process-wide write limit from all other tests and user files.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(".workspace-owner.json");
    let mut original = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    unsafe {
        assert_eq!(libc::getrlimit(libc::RLIMIT_FSIZE, &mut original), 0);
        libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
    }
    for bytes in [0, 17] {
        let limit = libc::rlimit {
            rlim_cur: bytes,
            rlim_max: original.rlim_max,
        };
        unsafe {
            assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
        }
        let result = Owner::acquire(directory.path(), "fixture");
        unsafe {
            assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &original), 0);
        }
        assert!(result.is_err());
        assert!(
            !path.exists(),
            "A failed first write must not strand the owner lock"
        );
        let owner = Owner::acquire(directory.path(), "fixture").unwrap();
        owner.check().unwrap();
        let identity = fs::read(&path).unwrap();
        assert_eq!(
            Owner::acquire(directory.path(), "fixture")
                .err()
                .unwrap()
                .code,
            "WORKSPACE_LOCKED"
        );
        assert_eq!(fs::read(&path).unwrap(), identity);
        drop(owner);
        assert!(!path.exists());
    }
    fs::write(&path, b"existing damaged identity").unwrap();
    assert_eq!(
        Owner::acquire(directory.path(), "fixture")
            .err()
            .unwrap()
            .code,
        "WORKSPACE_LOCKED"
    );
    assert_eq!(fs::read(path).unwrap(), b"existing damaged identity");
}
