use super::*;

fn lines(chunks: Vec<Bytes>) -> Lines {
    Lines::new(
        futures_util::stream::iter(chunks.into_iter().map(Ok)).boxed(),
        Duration::from_secs(1),
    )
}

async fn read_all(mut reader: Lines) -> Result<Vec<String>> {
    let mut output = Vec::new();
    while let Some(line) = reader.next().await? {
        output.push(line);
    }
    Ok(output)
}

#[tokio::test]
async fn framing_preserves_empty_crlf_partial_utf8_and_final_tail() {
    let raw = "\n你好\r\n\nworld\n末尾".as_bytes();
    let expected = vec!["", "你好\r", "", "world", "末尾"];
    for size in 1..=raw.len() {
        let chunks = raw.chunks(size).map(Bytes::copy_from_slice).collect();
        assert_eq!(read_all(lines(chunks)).await.unwrap(), expected);
    }
    let mut reader = lines(vec![Bytes::from_static(b"a\xff\n")]);
    assert_eq!(reader.next().await.unwrap().as_deref(), Some("a�"));
    assert!(reader.next().await.unwrap().is_none());
    assert!(reader.next().await.unwrap().is_none());
}

#[tokio::test]
async fn frame_budget_accepts_exact_limit_and_rejects_overflow() {
    let mut exact = vec![b'a'; FRAME_LIMIT];
    exact.push(b'\n');
    let mut reader = lines(vec![Bytes::from(exact)]);
    assert_eq!(reader.next().await.unwrap().unwrap().len(), FRAME_LIMIT);
    assert!(reader.next().await.unwrap().is_none());
    for suffix in [b"".as_slice(), b"\n".as_slice()] {
        let mut reader = lines(vec![
            Bytes::from_static(b"ok\n"),
            Bytes::from(vec![b'a'; FRAME_LIMIT]),
            Bytes::from([b"a".as_slice(), suffix].concat()),
        ]);
        assert_eq!(reader.next().await.unwrap().as_deref(), Some("ok"));
        assert_eq!(reader.next().await.unwrap_err().code, "STREAM_BUDGET");
    }
}

#[tokio::test]
async fn total_budget_and_idle_deadline_still_apply() {
    let chunk = Bytes::from([vec![b'a'; FRAME_LIMIT - 1], vec![b'\n']].concat());
    let mut reader = lines(vec![chunk; 16]);
    for _ in 0..16 {
        assert_eq!(reader.next().await.unwrap().unwrap().len(), FRAME_LIMIT - 1);
    }
    assert!(reader.next().await.unwrap().is_none());
    let chunk = Bytes::from([vec![b'a'; FRAME_LIMIT - 1], vec![b'\n']].concat());
    let mut reader = lines([vec![chunk; 16], vec![Bytes::from_static(b"x")]].concat());
    for _ in 0..16 {
        reader.next().await.unwrap();
    }
    assert_eq!(reader.next().await.unwrap_err().code, "STREAM_BUDGET");
    let mut reader = Lines::new(futures_util::stream::pending().boxed(), Duration::ZERO);
    assert_eq!(reader.next().await.unwrap_err().code, "UPSTREAM_TIMEOUT");
}

// Preserve the previous parser only as a benchmark baseline. Both readers use
// the same ready stream, timeout, UTF-8 conversion and byte budgets.
struct Previous(Lines);
impl Previous {
    async fn next(&mut self) -> Result<Option<String>> {
        let reader = &mut self.0;
        loop {
            let newline = reader.buffer.iter().position(|b| *b == b'\n');
            if newline.unwrap_or(reader.buffer.len()) > FRAME_LIMIT {
                return Err(Error::stream("STREAM_BUDGET", "响应超过单帧预算"));
            }
            if let Some(index) = newline {
                let mut bytes = reader.buffer.drain(..=index).collect::<Vec<_>>();
                bytes.pop();
                return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
            }
            if reader.ended {
                return if reader.buffer.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(
                        String::from_utf8_lossy(&std::mem::take(&mut reader.buffer)).into_owned(),
                    ))
                };
            }
            match tokio::time::timeout(reader.idle, reader.source.next())
                .await
                .map_err(|_| Error::stream("UPSTREAM_TIMEOUT", "聊天流超时"))?
            {
                Some(Ok(chunk)) => {
                    reader.total = reader.total.saturating_add(chunk.len());
                    if reader.total > TOTAL_LIMIT {
                        return Err(Error::stream("STREAM_BUDGET", "响应超过总字节预算"));
                    }
                    reader.buffer.extend_from_slice(&chunk);
                }
                Some(Err(_)) => return Err(Error::stream("INCOMPLETE_STREAM", "聊天流中断")),
                None => reader.ended = true,
            }
        }
    }
}

#[tokio::test]
#[ignore = "isolated parser benchmark; run in release with --ignored --nocapture"]
async fn parser_performance() {
    let short = Bytes::from(("x".repeat(63) + "\n").repeat(8192));
    let fragmented = Bytes::from("x".repeat(256 * 1024) + "\n");
    for (name, chunks) in [
        ("8192_short_lines", vec![short]),
        (
            "256k_frame_128b_chunks",
            fragmented.chunks(128).map(Bytes::copy_from_slice).collect(),
        ),
    ] {
        let expected = read_all(lines(chunks.clone())).await.unwrap();
        let mut previous = Previous(lines(chunks.clone()));
        let mut actual = Vec::new();
        while let Some(line) = previous.next().await.unwrap() {
            actual.push(line);
        }
        assert_eq!(actual, expected);
        let mut old_times = Vec::new();
        let mut new_times = Vec::new();
        for round in 0..7 {
            // Alternate ordering to reduce first-run and CPU-frequency bias.
            for old in [round % 2 == 0, round % 2 != 0] {
                let reader = lines(chunks.clone());
                let started = std::time::Instant::now();
                if old {
                    let mut reader = Previous(reader);
                    while let Some(line) = reader.next().await.unwrap() {
                        std::hint::black_box(line);
                    }
                    old_times.push(started.elapsed().as_nanos());
                } else {
                    let mut reader = reader;
                    while let Some(line) = reader.next().await.unwrap() {
                        std::hint::black_box(line);
                    }
                    new_times.push(started.elapsed().as_nanos());
                }
            }
        }
        old_times.sort_unstable();
        new_times.sort_unstable();
        println!(
            "{}",
            serde_json::json!({"case":name,"oldMedianNs":old_times[3],
            "newMedianNs":new_times[3],"oldSamplesNsSorted":old_times,"newSamplesNsSorted":new_times,
            "rounds":7,"equal":true})
        );
    }
}
