use std::collections::HashMap;

#[derive(Clone)]
pub enum ShellValue {
    Scalar(String),
    Array(Vec<String>),
    AssocArray(HashMap<String, String>),
}

impl ShellValue {
    pub fn as_scalar(&self) -> &str {
        match self {
            ShellValue::Scalar(s) => s.as_str(),
            ShellValue::Array(v) => v.first().map(|s| s.as_str()).unwrap_or(""),
            ShellValue::AssocArray(_) => "",
        }
    }

    pub fn index(&self, i: usize) -> &str {
        match self {
            ShellValue::Scalar(s) => if i == 0 { s.as_str() } else { "" },
            ShellValue::Array(v) => v.get(i).map(|s| s.as_str()).unwrap_or(""),
            ShellValue::AssocArray(_) => "",
        }
    }

    pub fn assoc_get(&self, key: &str) -> &str {
        match self {
            ShellValue::AssocArray(map) => map.get(key).map(|s| s.as_str()).unwrap_or(""),
            _ => "",
        }
    }

    pub fn assoc_set(&mut self, key: String, value: String) {
        if let ShellValue::AssocArray(map) = self {
            map.insert(key, value);
        }
    }

    pub fn assoc_keys(&self) -> Vec<String> {
        match self {
            ShellValue::AssocArray(map) => map.keys().cloned().collect(),
            ShellValue::Array(v) => (0..v.len()).map(|i| i.to_string()).collect(),
            ShellValue::Scalar(_) => vec!["0".to_string()],
        }
    }

    pub fn len(&self) -> usize {
        match self {
            ShellValue::Scalar(_) => 1,
            ShellValue::Array(v) => v.len(),
            ShellValue::AssocArray(map) => map.len(),
        }
    }

    pub fn all_elements(&self) -> String {
        match self {
            ShellValue::Scalar(s) => s.clone(),
            ShellValue::Array(v) => v.join(" "),
            ShellValue::AssocArray(map) => {
                let vals: Vec<&String> = map.values().collect();
                vals.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_shell_value_assoc_array() {
        let mut map = HashMap::new();
        map.insert("key1".to_string(), "val1".to_string());
        map.insert("key2".to_string(), "val2".to_string());
        let mut v = ShellValue::AssocArray(map);
        assert_eq!(v.assoc_get("key1"), "val1");
        assert_eq!(v.assoc_get("key2"), "val2");
        assert_eq!(v.assoc_get("missing"), "");
        assert_eq!(v.len(), 2);
        v.assoc_set("key3".to_string(), "val3".to_string());
        assert_eq!(v.assoc_get("key3"), "val3");
        assert_eq!(v.len(), 3);
        let keys = v.assoc_keys();
        assert!(keys.contains(&"key1".to_string()));
        assert!(keys.contains(&"key2".to_string()));
        assert!(keys.contains(&"key3".to_string()));
    }
}
