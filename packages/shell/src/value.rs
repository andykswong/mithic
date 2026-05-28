#[derive(Clone)]
pub enum ShellValue {
    Scalar(String),
    Array(Vec<String>),
}

impl ShellValue {
    pub fn as_scalar(&self) -> &str {
        match self {
            ShellValue::Scalar(s) => s.as_str(),
            ShellValue::Array(v) => v.first().map(|s| s.as_str()).unwrap_or(""),
        }
    }

    pub fn index(&self, i: usize) -> &str {
        match self {
            ShellValue::Scalar(s) => if i == 0 { s.as_str() } else { "" },
            ShellValue::Array(v) => v.get(i).map(|s| s.as_str()).unwrap_or(""),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            ShellValue::Scalar(_) => 1,
            ShellValue::Array(v) => v.len(),
        }
    }

    pub fn all_elements(&self) -> String {
        match self {
            ShellValue::Scalar(s) => s.clone(),
            ShellValue::Array(v) => v.join(" "),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ShellValue;

    #[test]
    fn test_shell_value_scalar() {
        let v = ShellValue::Scalar("hello".to_string());
        assert_eq!(v.as_scalar(), "hello");
        assert_eq!(v.index(0), "hello");
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn test_shell_value_array() {
        let v = ShellValue::Array(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(v.as_scalar(), "a");
        assert_eq!(v.index(0), "a");
        assert_eq!(v.index(1), "b");
        assert_eq!(v.index(2), "c");
        assert_eq!(v.index(99), "");
        assert_eq!(v.len(), 3);
        assert_eq!(v.all_elements(), "a b c");
    }
}
