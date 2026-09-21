/// All privileged pages must stay on the current authenticated gateway origin.
pub fn same_gateway_origin(expected: &str, url: &tauri::Url) -> bool {
    let Ok(gateway) = tauri::Url::parse(expected) else { return false; };
    gateway.scheme() == "http" && gateway.host_str() == Some("127.0.0.1")
        && gateway.username().is_empty() && gateway.password().is_none()
        && url.username().is_empty() && url.password().is_none()
        && url.origin() == gateway.origin()
}


#[cfg(test)]
mod gateway_origin_tests {
    use super::*;
    #[test]
    fn only_current_origin_can_navigate_or_invoke() {
        let expected = "http://127.0.0.1:4312";
        for allowed in ["http://127.0.0.1:4312/", "http://127.0.0.1:4312/companion-chat"] {
            assert!(same_gateway_origin(expected, &allowed.parse().unwrap()));
        }
        for denied in ["http://127.0.0.1:3000/", "https://127.0.0.1:4312/", "http://localhost:4312/", "https://example.com/", "http://user@127.0.0.1:4312/"] {
            assert!(!same_gateway_origin(expected, &denied.parse().unwrap()));
        }
        assert!(!same_gateway_origin("", &expected.parse().unwrap()));
    }
}
