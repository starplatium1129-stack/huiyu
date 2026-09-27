// A tiny, generated ONNX graph for ABI/tensor tests, not trained WD14 weights.
// Field numbers follow https://github.com/onnx/onnx/blob/main/onnx/onnx.proto3.
fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        out.push(byte | if value > 0 { 128 } else { 0 });
        if value == 0 {
            return out;
        }
    }
}
fn number(field: u64, value: u64) -> Vec<u8> {
    [varint(field << 3), varint(value)].concat()
}
fn blob(field: u64, value: impl AsRef<[u8]>) -> Vec<u8> {
    let value = value.as_ref();
    [
        varint((field << 3) | 2),
        varint(value.len() as u64),
        value.to_vec(),
    ]
    .concat()
}
fn tensor(name: &str, shape: &[u64], values: &[f32]) -> Vec<u8> {
    let mut out = Vec::new();
    for dimension in shape {
        out.extend(number(1, *dimension));
    }
    out.extend(number(2, 1));
    out.extend(blob(8, name));
    out.extend(blob(
        9,
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>(),
    ));
    out
}
fn value(name: &str, shape: &[u64]) -> Vec<u8> {
    let dimensions: Vec<u8> = shape
        .iter()
        .flat_map(|dimension| blob(1, number(1, *dimension)))
        .collect();
    [
        blob(1, name),
        blob(2, blob(1, [number(1, 1), blob(2, dimensions)].concat())),
    ]
    .concat()
}
fn node(kind: &str, inputs: &[&str], output: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for input in inputs {
        out.extend(blob(1, input));
    }
    out.extend(blob(2, output));
    out.extend(blob(4, kind));
    out
}
pub fn write(root: &std::path::Path) -> std::path::PathBuf {
    std::fs::create_dir_all(root).unwrap();
    let mut mean = node("ReduceMean", &["image"], "mean");
    mean.extend(blob(
        5,
        [
            blob(1, "axes"),
            number(20, 7),
            number(8, 1),
            number(8, 2),
            number(8, 3),
        ]
        .concat(),
    ));
    mean.extend(blob(
        5,
        [blob(1, "keepdims"), number(20, 2), number(3, 0)].concat(),
    ));
    let graph = [
        blob(1, mean),
        blob(1, node("Mul", &["mean", "zero"], "ignored")),
        blob(1, node("Add", &["ignored", "base"], "predictions_sigmoid")),
        blob(2, "synthetic-wd14-abi-fixture"),
        blob(5, tensor("zero", &[], &[0.0])),
        blob(
            5,
            tensor(
                "base",
                &[1, 8],
                &[0.7, 0.1, 0.08, 0.02, 0.8, 0.9, 0.95, 0.2],
            ),
        ),
        blob(11, value("image", &[1, 448, 448, 3])),
        blob(12, value("predictions_sigmoid", &[1, 8])),
    ]
    .concat();
    let model = [
        number(1, 8),
        blob(2, "huiyu-synthetic-fixture"),
        blob(7, graph),
        blob(8, number(2, 11)),
    ]
    .concat();
    let path = root.join("fixture.onnx");
    std::fs::write(&path, model).unwrap();
    std::fs::write(root.join("fixture.csv"),"tag_id,name,category\n0,general,9\n1,sensitive,9\n2,questionable,9\n3,explicit,9\n4,1girl,0\n5,blue_hair,0\n6,fixture_character,4\n7,not_selected,4\n").unwrap();
    path
}
