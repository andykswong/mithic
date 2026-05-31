use super::{write_stdout, write_stderr, read_input};

const ENCODE_TABLE: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn decode_char(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a'),
        b'2'..=b'7' => Some(c - b'2' + 26),
        _ => None,
    }
}

fn encode(data: &[u8], wrap: usize) -> String {
    let mut out = String::new();
    let mut col = 0;

    let mut i = 0;
    while i < data.len() {
        let remaining = data.len() - i;

        // Gather up to 5 bytes
        let b0 = data[i];
        let b1 = if remaining > 1 { data[i + 1] } else { 0 };
        let b2 = if remaining > 2 { data[i + 2] } else { 0 };
        let b3 = if remaining > 3 { data[i + 3] } else { 0 };
        let b4 = if remaining > 4 { data[i + 4] } else { 0 };

        // Encode into 8 characters
        let chars: [u8; 8] = [
            ENCODE_TABLE[(b0 >> 3) as usize],
            ENCODE_TABLE[(((b0 & 0x07) << 2) | (b1 >> 6)) as usize],
            if remaining > 1 { ENCODE_TABLE[(((b1 & 0x3E) >> 1)) as usize] } else { b'=' },
            if remaining > 1 { ENCODE_TABLE[(((b1 & 0x01) << 4) | (b2 >> 4)) as usize] } else { b'=' },
            if remaining > 2 { ENCODE_TABLE[(((b2 & 0x0F) << 1) | (b3 >> 7)) as usize] } else { b'=' },
            if remaining > 3 { ENCODE_TABLE[(((b3 & 0x7C) >> 2)) as usize] } else { b'=' },
            if remaining > 3 { ENCODE_TABLE[(((b3 & 0x03) << 3) | (b4 >> 5)) as usize] } else { b'=' },
            if remaining > 4 { ENCODE_TABLE[(b4 & 0x1F) as usize] } else { b'=' },
        ];

        for &ch in &chars {
            out.push(ch as char);
            col += 1;
            if wrap > 0 && col >= wrap {
                out.push('\n');
                col = 0;
            }
        }

        i += 5;
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
        let chunk_end = (i + 8).min(filtered.len());
        let chunk = &filtered[i..chunk_end];

        if chunk.len() < 8 {
            return Err("invalid input");
        }

        // Decode up to 8 characters into 5 bytes
        let mut vals = [0u8; 8];
        let mut pad_start = 8;
        for (j, &c) in chunk.iter().enumerate() {
            if c == b'=' {
                if pad_start == 8 {
                    pad_start = j;
                }
                vals[j] = 0;
            } else {
                match decode_char(c) {
                    Some(v) => vals[j] = v,
                    None => return Err("invalid input"),
                }
            }
        }

        // Reconstruct bytes
        // byte 0: vals[0] << 3 | vals[1] >> 2
        if pad_start > 1 {
            out.push((vals[0] << 3) | (vals[1] >> 2));
        }
        // byte 1: vals[1] << 6 | vals[2] << 1 | vals[3] >> 4
        if pad_start > 3 {
            out.push((vals[1] << 6) | (vals[2] << 1) | (vals[3] >> 4));
        }
        // byte 2: vals[3] << 4 | vals[4] >> 1
        if pad_start > 4 {
            out.push((vals[3] << 4) | (vals[4] >> 1));
        }
        // byte 3: vals[4] << 7 | vals[5] << 2 | vals[6] >> 3
        if pad_start > 6 {
            out.push((vals[4] << 7) | (vals[5] << 2) | (vals[6] >> 3));
        }
        // byte 4: vals[6] << 5 | vals[7]
        if pad_start > 7 {
            out.push((vals[6] << 5) | vals[7]);
        }

        i += 8;
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
                    write_stderr("base32: option requires an argument -- 'w'\n");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => wrap = n,
                    Err(_) => {
                        write_stderr(&format!("base32: invalid wrap size: '{}'\n", args[i]));
                        return 1;
                    }
                }
            }
            arg if arg.starts_with('-') && arg.len() > 1 => {
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
                                        write_stderr(&format!("base32: invalid wrap size: '{}'\n", rest));
                                        return 1;
                                    }
                                }
                                break;
                            } else {
                                i += 1;
                                if i >= args.len() {
                                    write_stderr("base32: option requires an argument -- 'w'\n");
                                    return 1;
                                }
                                match args[i].parse::<usize>() {
                                    Ok(n) => wrap = n,
                                    Err(_) => {
                                        write_stderr(&format!("base32: invalid wrap size: '{}'\n", args[i]));
                                        return 1;
                                    }
                                }
                                break;
                            }
                        }
                        _ => {
                            write_stderr(&format!("base32: invalid option -- '{}'\n", chars[j]));
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

    let (data, errors) = read_input(&file_args);
    if errors != 0 {
        return errors;
    }

    if decode_mode {
        match decode(&data) {
            Ok(decoded) => {
                use std::io::Write;
                let mut out = std::io::stdout();
                out.write_all(&decoded).ok();
                out.flush().ok();
            }
            Err(e) => {
                write_stderr(&format!("base32: {}\n", e));
                return 1;
            }
        }
    } else {
        let encoded = encode(&data, wrap);
        write_stdout(&encoded);
    }

    0
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
        // "Hello" -> JBSWY3DP
        assert_eq!(encode(b"Hello", 76), "JBSWY3DP\n");
    }

    #[test]
    fn encode_one_byte() {
        // "f" -> MY======
        assert_eq!(encode(b"f", 76), "MY======\n");
    }

    #[test]
    fn encode_two_bytes() {
        // "fo" -> MZXQ====
        assert_eq!(encode(b"fo", 76), "MZXQ====\n");
    }

    #[test]
    fn encode_three_bytes() {
        // "foo" -> MZXW6===
        assert_eq!(encode(b"foo", 76), "MZXW6===\n");
    }

    #[test]
    fn encode_four_bytes() {
        // "foob" -> MZXW6YQ=
        assert_eq!(encode(b"foob", 76), "MZXW6YQ=\n");
    }

    #[test]
    fn encode_five_bytes() {
        // "fooba" -> MZXW6YTB
        assert_eq!(encode(b"fooba", 76), "MZXW6YTB\n");
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
        let input = b"Man is distinguished, not only by his reason";
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
        assert_eq!(decode(b"JBSWY3DP").unwrap(), b"Hello");
    }

    #[test]
    fn decode_with_padding() {
        assert_eq!(decode(b"MY======").unwrap(), b"f");
        assert_eq!(decode(b"MZXQ====").unwrap(), b"fo");
        assert_eq!(decode(b"MZXW6===").unwrap(), b"foo");
        assert_eq!(decode(b"MZXW6YQ=").unwrap(), b"foob");
    }

    #[test]
    fn decode_with_newlines() {
        assert_eq!(decode(b"JBSWY3DP\n").unwrap(), b"Hello");
    }

    #[test]
    fn decode_case_insensitive() {
        assert_eq!(decode(b"jbswy3dp").unwrap(), b"Hello");
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
        assert!(decode(b"JBSWY3D!").is_err());
    }

    #[test]
    fn decode_incomplete_block() {
        assert!(decode(b"JBSWY3").is_err());
    }
}
