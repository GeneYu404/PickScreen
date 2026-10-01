//! 手写的 base64 解码（dataURL -> 字节），不引入额外依赖

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("非法 base64 字符: {}", c as char)),
        }
    }

    let s: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut i = 0;
    while i < s.len() {
        let rest = s.len() - i;
        if rest == 1 {
            return Err("base64 长度非法".into());
        }
        // 最后一块可能是 2/3 字节的无填充形式（canvas.toDataURL 去填充常见）
        let take = rest.min(4);
        let chunk = &s[i..i + take];
        i += take;
        if chunk[0] == b'=' || chunk[1] == b'=' {
            break;
        }
        let a = val(chunk[0])? as u32;
        let b = val(chunk[1])? as u32;
        out.push(((a << 2) | (b >> 4)) as u8);
        if take == 2 || chunk[2] == b'=' {
            break;
        }
        let c = val(chunk[2])? as u32;
        out.push((((b & 0x0f) << 4) | (c >> 2)) as u8);
        if take == 3 || chunk[3] == b'=' {
            break;
        }
        let d = val(chunk[3])? as u32;
        out.push((((c & 0x03) << 6) | d) as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        // "hello" -> aGVsbG8=
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("aGVsbG8").unwrap(), b"hello");
        assert_eq!(b64_decode("QQ==").unwrap(), b"A");
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB");
        assert!(b64_decode("!@#$").is_err());
    }
}
