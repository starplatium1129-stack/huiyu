use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};
#[test]
fn node_css_sfc_and_tailwind_candidates_keep_the_same_policy_findings() {
    let cases = json!([
        {"file":"fixture.css","source":"/* #123abc\n tw:bg-[#123abc] */\n.a { color: #123abc; background: #aaf; }\n--custom: #123abc;\n.b { color: #fff; border: #987; }\n.c { color: color-mix(in srgb,#123abc,#fff); }\n.d { color: rgba(0,0,0,1); border:#987; }\n.e { color: ##123abc; border: #123abcd; }\n@apply tw:bg-[#abcdef] tw:w-[12px];"},
        {"file":"fixture.vue","source":"<template> <div class=\"tw:hover:[&:not(.active)]:bg-[rgb(1_2_3)]/50 tw:text-[length:20px] tw:text-[red] tw:[--tw-gradient-from:#abcdef] tw:border-[var(--border)] tw:fill-[currentcolor] tw:shadow-[0_0_2px_#abcdef]\" /> </template>\n<style scoped>\n.foo { color:#456abc; border:#789; }\n// #987abc\n</style>\n<script>const token='#765432'</script>"},
        {"file":"fixture.ts","source":"const ui = 'tw:!text-[Blue]! tw:text-[calc(1rem+1px)] tw:[color:color(display-p3_1_0_0)]';\n// tw:bg-[red]\n/* tw:fill-[lime] */\nconst other='notw:fill-[pink] 中文tw:stroke-[pink] tw:ring-offset-[rgba(2,3,4,.5)]';"},
        {"file":"fixture.html","source":"<!-- tw:bg-[red] -->\n<style>.inline {color:#abcd12}</style>\n<style>\n.x {background:url(data:image/png;base64,AAAA);color:#987abc;}\n</style>\n<span class=\"tw:bg-[url(http://fixture/#abcdef)] tw:text-[transparent] tw:[font-size:red] tw:border-x-[green]\"></span>"}
    ]);
    let mut command = Command::new("node");
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/maintenance/colors/legacy-oracle.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&cases).unwrap())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Value = serde_json::from_slice(&result.stdout).unwrap();
    let actual = Value::Array(
        cases
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                json!(scan(
                    Path::new(c["file"].as_str().unwrap()),
                    c["source"].as_str().unwrap()
                ))
            })
            .collect(),
    );
    assert_eq!(
        actual,
        expected,
        "Rust {}\nNode {}",
        serde_json::to_string_pretty(&actual).unwrap(),
        serde_json::to_string_pretty(&expected).unwrap()
    );
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("src/vendor")).unwrap();
    std::fs::create_dir_all(temp.path().join("docs/archive")).unwrap();
    std::fs::write(
        temp.path().join("src/neutral.css"),
        ".x { color: #123abc; }",
    )
    .unwrap();
    for path in [
        "src/neutral.spec.ts",
        "src/vendor/neutral.css",
        "docs/archive/neutral.css",
    ] {
        std::fs::write(temp.path().join(path), "tw:bg-[#123abc]").unwrap();
    }
    let output = report(temp.path(), &CancellationToken::new()).unwrap();
    assert!(output.starts_with("⚠️  1 hardcoded hex color(s) found:"));
    assert!(!output.contains("vendor"));
    assert!(!output.contains("archive"));
}
