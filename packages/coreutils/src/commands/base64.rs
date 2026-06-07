use super::{write_stdout, write_stderr, read_input};

const ENCODE_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn decode_char(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn encode(data: &[u8], wrap: usize) -> String {
    let mut out = String::new();
    let mut col = 0;

    let mut i = 0;
    while i + 2 < data.len() {
        let b0 = data[i];
        let b1 = data[i + 1];
        let b2 = data[i + 2];

        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize],
            ENCODE_TABLE[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize],
            ENCODE_TABLE[(b2 & 0x3F) as usize],
        ];

        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
        i += 3;
    }

    let remaining = data.len() - i;
    if remaining == 1 {
        let b0 = data[i];
        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[((b0 & 0x03) << 4) as usize],
            b'=',
            b'=',
        ];
        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
    } else if remaining == 2 {
        let b0 = data[i];
        let b1 = data[i + 1];
        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize],
            ENCODE_TABLE[((b1 & 0x0F) << 2) as usize],
            b'=',
        ];
        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
    }

    if col > 0 {
        out.push('\n');
    }
    out
}

fn decode(data: &[u8]) -> Result<Vec<u8>, &'static str> {
    let filtered: Vec<u8> = data.iter()
        .copied()
        .filter(|&b| !b.is_ascii_whitespace())
        .collect();

    if filtered.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut i = 0;

    while i < filtered.len() {
        let chunk_end = (i + 4).min(filtered.len());
        let chunk = &filtered[i..chunk_end];

        if chunk.len() < 4 {
            return Err("invalid input");
        }

        let c0 = match decode_char(chunk[0]) {
            Some(v) => v,
            None => return Err("invalid input"),
        };
        let c1 = match decode_char(chunk[1]) {
            Some(v) => v,
            None => return Err("invalid input"),
        };

        out.push((c0 << 2) | (c1 >> 4));

        if chunk[2] != b'=' {
            let c2 = match decode_char(chunk[2]) {
                Some(v) => v,
                None => return Err("invalid input"),
            };
            out.push((c1 << 4) | (c2 >> 2));

            if chunk[3] != b'=' {
                let c3 = match decode_char(chunk[3]) {
                    Some(v) => v,
                    None => return Err("invalid input"),
                };
                out.push((c2 << 6) | c3);
            }
        }

        i += 4;
    }

    Ok(out)
}

pub fn run(args: &[&str]) -> u8 {
    let mut decode_mode = false;
    let mut wrap: usize = 76;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" | "--decode" => decode_mode = true,
            "-w" | "--wrap" => {
                i += 1;
                if i >= args.len() {
                    write_stderr("base64: option requires an argument -- 'w'\n");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => wrap = n,
                    Err(_) => {
                        write_stderr(&format!("base64: invalid wrap size: '{}'\n", args[i]));
                        return 1;
                    }
                }
            }
            arg if arg.starts_with('-') && arg.len() > 1 => {
                // Handle combined flags like -dw0
                let chars: Vec<char> = arg[1..].chars().collect();
                let mut j = 0;
                while j < chars.len() {
                    match chars[j] {
                        'd' => decode_mode = true,
                        'w' => {
                            let rest: String = chars[j+1..].iter().collect();
                            if !rest.is_empty() {
                                match rest.parse::<usize>() {
                                    Ok(n) => wrap = n,
                                    Err(_) => {
                                        write_stderr(&format!("base64: invalid wrap size: '{}'\n", rest));
                                        return 1;
                                    }
                                }
                                break;
                            } else {
                                i += 1;
                                if i >= args.len() {
                                    write_stderr("base64: option requires an argument -- 'w'\n");
                                    return 1;
                                }
                                match args[i].parse::<usize>() {
                                    Ok(n) => wrap = n,
                                    Err(_) => {
                                        write_stderr(&format!("base64: invalid wrap size: '{}'\n", args[i]));
                                        return 1;
                                    }
                                }
                                break;
                            }
                        }
                        _ => {
                            write_stderr(&format!("base64: invalid option -- '{}'\n", chars[j]));
                            return 1;
                        }
                    }
                    j += 1;
                }
            }
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    if decode_mode {
        let (data, errors) = read_input(&file_args);
        if errors != 0 {
            return errors;
        }
        match decode(&data) {
            Ok(decoded) => {
                use std::io::Write;
                let mut out = std::io::stdout();
                out.write_all(&decoded).ok();
                out.flush().ok();
            }
            Err(e) => {
                write_stderr(&format!("base64: {}\n", e));
                return 1;
            }
        }
    } else if file_args.is_empty() {
        encode_stream_stdin(wrap);
    } else {
        let (data, errors) = read_input(&file_args);
        if errors != 0 {
            return errors;
        }
        let encoded = encode(&data, wrap);
        write_stdout(&encoded);
    }

    0
}

fn encode_stream_stdin(wrap: usize) {
    use std::io::Read;
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    // Read in chunks that are multiples of 3 so base64 encoding aligns
    const CHUNK_SIZE: usize = 4095; // 3 * 1365
    let mut buf = [0u8; CHUNK_SIZE];
    let mut remainder: Vec<u8> = Vec::new();
    let mut col = 0usize;

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        remainder.extend_from_slice(&buf[..n]);

        // Encode complete 3-byte groups
        let usable = (remainder.len() / 3) * 3;
        if usable > 0 {
            let to_encode = &remainder[..usable];
            col = encode_chunk_write(to_encode, wrap, col);
            remainder.drain(..usable);
        }
    }

    // Encode any remaining bytes (1 or 2 leftover)
    if !remainder.is_empty() {
        encode_chunk_write(&remainder, wrap, col);
    } else if col > 0 {
        write_stdout("\n");
    }
}

fn encode_chunk_write(data: &[u8], wrap: usize, mut col: usize) -> usize {
    let mut out = String::new();
    let mut i = 0;

    while i + 2 < data.len() {
        let b0 = data[i];
        let b1 = data[i + 1];
        let b2 = data[i + 2];

        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize],
            ENCODE_TABLE[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize],
            ENCODE_TABLE[(b2 & 0x3F) as usize],
        ];

        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
        i += 3;
    }

    // Handle remaining 1 or 2 bytes (final padding)
    let remaining = data.len() - i;
    if remaining == 1 {
        let b0 = data[i];
        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[((b0 & 0x03) << 4) as usize],
            b'=',
            b'=',
        ];
        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
    } else if remaining == 2 {
        let b0 = data[i];
        let b1 = data[i + 1];
        let chars = [
            ENCODE_TABLE[(b0 >> 2) as usize],
            ENCODE_TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize],
            ENCODE_TABLE[((b1 & 0x0F) << 2) as usize],
            b'=',
        ];
        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }
    }

    if col > 0 && (data.len() % 3 != 0) {
        // Final chunk with padding — add trailing newline
        out.push('\n');
        col = 0;
    }

    write_stdout(&out);
    col
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_empty() {
        assert_eq!(encode(b"", 76), "");
    }

    #[test]
    fn encode_hello() {
        assert_eq!(encode(b"Hello", 76), "SGVsbG8=\n");
    }

    #[test]
    fn encode_one_byte() {
        assert_eq!(encode(b"M", 76), "TQ==\n");
    }

    #[test]
    fn encode_two_bytes() {
        assert_eq!(encode(b"Ma", 76), "TWE=\n");
    }

    #[test]
    fn encode_three_bytes() {
        assert_eq!(encode(b"Man", 76), "TWFu\n");
    }

    #[test]
    fn encode_wrapping() {
        let input = b"Man is distinguished, not only by his reason, but by this singular passion from other animals";
        let encoded = encode(input, 76);
        for line in encoded.lines() {
            assert!(line.len() <= 76);
        }
    }

    #[test]
    fn encode_no_wrap() {
        let input = b"Man is distinguished, not only by his reason, but by this singular passion from other animals";
        let encoded = encode(input, 0);
        assert!(!encoded[..encoded.len()-1].contains('\n'));
        assert!(encoded.ends_with('\n'));
    }

    #[test]
    fn decode_empty() {
        assert_eq!(decode(b"").unwrap(), b"");
    }

    #[test]
    fn decode_hello() {
        assert_eq!(decode(b"SGVsbG8=").unwrap(), b"Hello");
    }

    #[test]
    fn decode_with_newlines() {
        assert_eq!(decode(b"SGVs\nbG8=\n").unwrap(), b"Hello");
    }

    #[test]
    fn decode_no_padding() {
        assert_eq!(decode(b"TWFu").unwrap(), b"Man");
    }

    #[test]
    fn decode_one_pad() {
        assert_eq!(decode(b"TWE=").unwrap(), b"Ma");
    }

    #[test]
    fn decode_two_pad() {
        assert_eq!(decode(b"TQ==").unwrap(), b"M");
    }

    #[test]
    fn roundtrip() {
        let input = b"The quick brown fox jumps over the lazy dog";
        let encoded = encode(input, 0);
        let decoded = decode(encoded.trim_end().as_bytes()).unwrap();
        assert_eq!(decoded, input);
    }

    #[test]
    fn roundtrip_binary() {
        let input: Vec<u8> = (0..=255).collect();
        let encoded = encode(&input, 0);
        let decoded = decode(encoded.trim_end().as_bytes()).unwrap();
        assert_eq!(decoded, input);
    }

    #[test]
    fn decode_invalid_char() {
        assert!(decode(b"SGVs!G8=").is_err());
    }

    #[test]
    fn decode_incomplete_block() {
        assert!(decode(b"SGV").is_err());
    }
}
