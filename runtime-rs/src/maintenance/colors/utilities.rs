use super::*;
fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn decoded(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'_') {
            chars.next();
            out.push('_');
        } else if c == '_' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}
fn core(candidate: &str) -> &str {
    let (mut depth, mut start) = (0, 0);
    for (at, c) in candidate.char_indices() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            ':' if depth == 0 => start = at + 1,
            _ => {}
        }
    }
    let value = candidate[start..]
        .strip_prefix('!')
        .unwrap_or(&candidate[start..]);
    value.strip_suffix('!').unwrap_or(value)
}
fn declaration(candidate: &str) -> Option<(String, String)> {
    static PROPERTY: LazyLock<Regex> = LazyLock::new(|| re(r"^([A-Za-z0-9_-]+):(.+)$"));
    static ARBITRARY: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?s)^-?([A-Za-z0-9_-]+)-\[(.+)\](?:/[^\s]+)?$"));
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"^(bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|accent|caret|fill|stroke|decoration|from|via|to|shadow|inset-shadow|divide-[xy])$",
        )
    });
    static TYPE: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:color|length|percentage|number):"));
    static SIZE: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?i)^(?:[-.0-9]|calc\(|clamp\(|min\(|max\()"));
    let core = core(candidate);
    if let Some(raw) = core.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        let captures = PROPERTY.captures(raw)?;
        return Some((captures[1].into(), decoded(&captures[2])));
    }
    let captures = ARBITRARY.captures(core)?;
    let prefix = &captures[1];
    let raw = &captures[2];
    let value = TYPE.replace(&decoded(raw), "").into_owned();
    if prefix == "text"
        && (raw.starts_with("length:") || raw.starts_with("percentage:") || SIZE.is_match(&value))
    {
        return None;
    }
    if !PREFIX.is_match(prefix) {
        return None;
    }
    Some((
        if prefix == "text" {
            "color".into()
        } else if prefix == "bg" {
            "background".into()
        } else {
            format!("{prefix}-color")
        },
        value,
    ))
}
fn literal(property: &str, value: &str) -> bool {
    static PROPERTIES: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"^(?:color|background(?:-color|-image)?|border(?:-[A-Za-z0-9_-]+)?|(?:box|text)-shadow|(?:outline|text-decoration|caret|accent|fill|stroke)(?:-color)?|--tw-gradient-.+)$",
        )
    });
    static LITERAL: LazyLock<Regex> = LazyLock::new(|| {
        re(r"(?i)#[0-9a-f]{3,8}(?-u:\b)|(?-u:\b)(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(")
    });
    if !PROPERTIES.is_match(property) && !property.ends_with("-color") {
        return false;
    }
    if LITERAL.is_match(value) {
        return true;
    }
    let allowed = [
        "transparent",
        "currentcolor",
        "inherit",
        "initial",
        "unset",
        "revert",
        "none",
    ];
    (property == "color"
        || property.ends_with("-color")
        || ["background", "fill", "stroke"].contains(&property))
        && !value.is_empty()
        && value.bytes().all(|b| b.is_ascii_alphabetic())
        && !allowed.contains(&value.to_ascii_lowercase().as_str())
}
pub(super) fn literals(source: &str) -> Vec<(String, usize)> {
    let source = comments(source, true);
    let mut found = Vec::new();
    for (at, _) in source.match_indices("tw:") {
        if at > 0 && source[..at].chars().next_back().is_some_and(ascii_word) {
            continue;
        }
        let (mut depth, mut escaped, mut end) = (0, false, source.len());
        for (offset, c) in source[at..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if c == '\\' {
                escaped = true;
                continue;
            }
            match c {
                '[' | '(' => depth += 1,
                ']' | ')' => {
                    if depth == 0 {
                        end = at + offset;
                        break;
                    }
                    depth -= 1;
                }
                c if depth == 0 && (c.is_whitespace() || "'\"`<>;{},".contains(c)) => {
                    end = at + offset;
                    break;
                }
                _ => {}
            }
        }
        let candidate = &source[at..end];
        if declaration(candidate).is_some_and(|(p, v)| literal(&p, &v)) {
            found.push((
                candidate.into(),
                source[..at].bytes().filter(|b| *b == b'\n').count() + 1,
            ));
        }
    }
    found
}
