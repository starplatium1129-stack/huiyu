use super::*;

pub(super) fn runtime_metrics() -> Value {
    json!({"schemaVersion":1,"timingMode":"cpu-wall-no-extra-sync","timingsAreAdditive":false,
        "existingReportSynchronization":false,"baseReused":true,"completedSteps":1,
        "timings":{"workerWallSeconds":4.0,"imagePreparationWallSeconds":0.1,"modelAcquireWallSeconds":0.2,
            "pipelineWallSeconds":3.0,"compositeWallSeconds":0.1,"outputSaveSeconds":0.2,"residentFingerprintSeconds":0.1},
        "textCache":{"enabled":true,"hits":1,"misses":0,"entries":1,"cpuBytes":1024},
        "maskCache":{"enabled":true,"used":false},"teaCache":{"enabled":false},
        "memory":{"status":"per-job-allocator","reason":null,"deviceIndex":0,
            "scope":"image-preparation-through-pipeline","peakAllocatedBytes":1234,"peakReservedBytes":2048}})
}
#[test]
fn runtime_metadata_is_optional_bounded_and_never_labels_history_as_job_peak() {
    let mut valid = runtime_metrics();
    valid["outputPath"] = json!("/private/path");
    valid["textCache"]["arbitrary"] = json!({"must":"not escape"});
    valid["memory"]["untrusted"] = json!("ignored");
    assert_eq!(native_runtime(&valid), runtime_metrics());
    assert_eq!(
        native_runtime(&Value::Null)["reason"],
        "worker-metrics-missing"
    );
    let mut cold = runtime_metrics();
    cold["memory"]["status"] = json!("unverified");
    cold["memory"]["reason"] = json!("cuda-uninitialized-at-window-start");
    cold["memory"]["peakAllocatedBytes"] = Value::Null;
    cold["memory"]["peakReservedBytes"] = Value::Null;
    assert_eq!(native_runtime(&cold), cold);
    cold["memory"]["peakAllocatedBytes"] = json!(999999);
    assert_eq!(native_runtime(&cold)["reason"], "invalid-worker-metrics");
    valid["timings"]["pipelineWallSeconds"] = json!(-1);
    assert_eq!(native_runtime(&valid)["reason"], "invalid-worker-metrics");
}
