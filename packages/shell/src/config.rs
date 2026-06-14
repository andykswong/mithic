pub(crate) const VERSION_MAJOR: &str = "5";
pub(crate) const VERSION_MINOR: &str = "3";
pub(crate) const VERSION_PATCH: &str = "0";
pub(crate) const VERSION_BUILD: &str = "1";
pub(crate) const VERSION_STATUS: &str = "release";
pub(crate) const VERSION_MACHTYPE: &str = env!("MITHIC_BUILD_TARGET");

pub(crate) fn bash_version_string() -> String {
    format!("{}.{}.{}({})-release", VERSION_MAJOR, VERSION_MINOR, VERSION_PATCH, VERSION_BUILD)
}

pub(crate) fn bash_versinfo_elements() -> Vec<String> {
    vec![
        VERSION_MAJOR.to_string(),
        VERSION_MINOR.to_string(),
        VERSION_PATCH.to_string(),
        VERSION_BUILD.to_string(),
        VERSION_STATUS.to_string(),
        VERSION_MACHTYPE.to_string(),
    ]
}

pub(crate) fn is_protected_version_var(name: &str) -> bool {
    name == "BASH_VERSION" || name == "BASH_VERSINFO"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bash_version_string_format() {
        let v = bash_version_string();
        assert!(v.starts_with("5.3.0(1)"));
        assert!(v.ends_with("-release"));
    }

    #[test]
    fn test_bash_versinfo_has_6_elements() {
        let elems = bash_versinfo_elements();
        assert_eq!(elems.len(), 6);
    }

    #[test]
    fn test_bash_versinfo_values() {
        let elems = bash_versinfo_elements();
        assert_eq!(elems[0], "5");
        assert_eq!(elems[1], "3");
        assert_eq!(elems[2], "0");
        assert_eq!(elems[3], "1");
        assert_eq!(elems[4], "release");
        assert!(!elems[5].is_empty(), "machtype should not be empty");
    }

    #[test]
    fn test_machtype_from_build_target() {
        let machtype = VERSION_MACHTYPE;
        assert!(!machtype.is_empty());
    }

    #[test]
    fn test_is_protected_version_var() {
        assert!(is_protected_version_var("BASH_VERSION"));
        assert!(is_protected_version_var("BASH_VERSINFO"));
        assert!(!is_protected_version_var("SHLVL"));
        assert!(!is_protected_version_var("HOME"));
    }
}
