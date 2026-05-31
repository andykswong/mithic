// chmod is a no-op in WASI/VFS context — the VFS does not track Unix permissions.
// This stub accepts the command without error for shell script compatibility.

pub fn run(_args: &[&str]) -> u8 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_returns_zero() {
        assert_eq!(run(&[]), 0);
        assert_eq!(run(&["644", "file.txt"]), 0);
        assert_eq!(run(&["755", "/usr/bin/foo"]), 0);
    }
}
