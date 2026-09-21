use ring::{hmac, rand::{SecureRandom, SystemRandom}};

pub fn valid_secret(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| "OS randomness unavailable".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn verify_proof(secret: &str, challenge: &str, proof: &str) -> bool {
    if proof.len() != 64 || !proof.bytes().all(|b| b.is_ascii_hexdigit()) { return false; }
    let bytes: Option<Vec<u8>> = (0..64).step_by(2).map(|i| u8::from_str_radix(&proof[i..i + 2], 16).ok()).collect();
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    bytes.map(|bytes| hmac::verify(&key, challenge.as_bytes(), &bytes).is_ok()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proofs_bind_the_secret_and_each_fresh_challenge() {
        let secret = random_secret().unwrap();
        let challenge = random_secret().unwrap();
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()), challenge.as_bytes());
        let proof: String = tag.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert!(verify_proof(&secret, &challenge, &proof));
        assert!(!verify_proof("wrong-secret", &challenge, &proof));
        assert!(!verify_proof(&secret, &random_secret().unwrap(), &proof));
        assert!(!verify_proof(&secret, &challenge, "not-hex"));
    }
}
