#[derive(Clone, Default)]
pub(crate) struct ShellOptions {
    pub errexit: bool,   // -e: exit on non-zero status
    pub nounset: bool,   // -u: error on unset variable expansion
    pub pipefail: bool,  // -o pipefail: pipeline fails if any command fails
    pub xtrace: bool,    // -x: print commands before execution
    pub verbose: bool,   // -v: print input lines to stderr
    pub noclobber: bool, // -C: prevent > from overwriting existing files
    pub posix: bool,     // --posix / set -o posix / POSIXLY_CORRECT: disable bash extensions

    pub extglob: bool,
    pub globstar: bool,
    pub nullglob: bool,
    pub dotglob: bool,
    pub nocaseglob: bool,
    pub nocasematch: bool,
    pub expand_aliases: bool,
    pub checkwinsize: bool,
    pub cmdhist: bool,
    pub complete_fullquote: bool,
    pub direxpand: bool,
    pub dirspell: bool,
    pub execfail: bool,
    pub force_fignore: bool,
    pub histappend: bool,
    pub histreedit: bool,
    pub histverify: bool,
    pub hostcomplete: bool,
    pub huponexit: bool,
    pub interactive_comments: bool,
    pub lithist: bool,
    pub login_shell: bool,
    pub mailwarn: bool,
    pub no_empty_cmd_completion: bool,
    pub progcomp: bool,
    pub promptvars: bool,
    pub shift_verbose: bool,
    pub sourcepath: bool,
    pub xpg_echo: bool,
}

const SHOPT_NAMES: &[&str] = &[
    "checkwinsize",
    "cmdhist",
    "complete_fullquote",
    "direxpand",
    "dirspell",
    "dotglob",
    "execfail",
    "expand_aliases",
    "extglob",
    "force_fignore",
    "globstar",
    "histappend",
    "histreedit",
    "histverify",
    "hostcomplete",
    "huponexit",
    "interactive_comments",
    "lithist",
    "login_shell",
    "mailwarn",
    "no_empty_cmd_completion",
    "nocaseglob",
    "nocasematch",
    "nullglob",
    "progcomp",
    "promptvars",
    "shift_verbose",
    "sourcepath",
    "xpg_echo",
];


impl ShellOptions {
    pub fn set_flag(&mut self, flag: char, enable: bool) -> bool {
        match flag {
            'e' => { self.errexit = enable; true }
            'u' => { self.nounset = enable; true }
            'x' => { self.xtrace = enable; true }
            'v' => { self.verbose = enable; true }
            'C' => { self.noclobber = enable; true }
            _ => false,
        }
    }

    pub fn set_o_flag(&mut self, name: &str, enable: bool) -> bool {
        match name {
            "errexit" => { self.errexit = enable; true }
            "nounset" => { self.nounset = enable; true }
            "pipefail" => { self.pipefail = enable; true }
            "xtrace" => { self.xtrace = enable; true }
            "verbose" => { self.verbose = enable; true }
            "noclobber" => { self.noclobber = enable; true }
            "posix" => { self.posix = enable; true }
            _ => false,
        }
    }

    pub fn set_shopt(&mut self, name: &str, enable: bool) -> Option<bool> {
        let prev = self.get_shopt(name)?;
        match name {
            "extglob" => self.extglob = enable,
            "globstar" => self.globstar = enable,
            "nullglob" => self.nullglob = enable,
            "dotglob" => self.dotglob = enable,
            "nocaseglob" => self.nocaseglob = enable,
            "nocasematch" => self.nocasematch = enable,
            "expand_aliases" => self.expand_aliases = enable,
            "checkwinsize" => self.checkwinsize = enable,
            "cmdhist" => self.cmdhist = enable,
            "complete_fullquote" => self.complete_fullquote = enable,
            "direxpand" => self.direxpand = enable,
            "dirspell" => self.dirspell = enable,
            "execfail" => self.execfail = enable,
            "force_fignore" => self.force_fignore = enable,
            "histappend" => self.histappend = enable,
            "histreedit" => self.histreedit = enable,
            "histverify" => self.histverify = enable,
            "hostcomplete" => self.hostcomplete = enable,
            "huponexit" => self.huponexit = enable,
            "interactive_comments" => self.interactive_comments = enable,
            "lithist" => self.lithist = enable,
            "login_shell" => self.login_shell = enable,
            "mailwarn" => self.mailwarn = enable,
            "no_empty_cmd_completion" => self.no_empty_cmd_completion = enable,
            "progcomp" => self.progcomp = enable,
            "promptvars" => self.promptvars = enable,
            "shift_verbose" => self.shift_verbose = enable,
            "sourcepath" => self.sourcepath = enable,
            "xpg_echo" => self.xpg_echo = enable,
            _ => return None,
        }
        Some(prev)
    }

    pub fn get_shopt(&self, name: &str) -> Option<bool> {
        match name {
            "extglob" => Some(self.extglob),
            "globstar" => Some(self.globstar),
            "nullglob" => Some(self.nullglob),
            "dotglob" => Some(self.dotglob),
            "nocaseglob" => Some(self.nocaseglob),
            "nocasematch" => Some(self.nocasematch),
            "expand_aliases" => Some(self.expand_aliases),
            "checkwinsize" => Some(self.checkwinsize),
            "cmdhist" => Some(self.cmdhist),
            "complete_fullquote" => Some(self.complete_fullquote),
            "direxpand" => Some(self.direxpand),
            "dirspell" => Some(self.dirspell),
            "execfail" => Some(self.execfail),
            "force_fignore" => Some(self.force_fignore),
            "histappend" => Some(self.histappend),
            "histreedit" => Some(self.histreedit),
            "histverify" => Some(self.histverify),
            "hostcomplete" => Some(self.hostcomplete),
            "huponexit" => Some(self.huponexit),
            "interactive_comments" => Some(self.interactive_comments),
            "lithist" => Some(self.lithist),
            "login_shell" => Some(self.login_shell),
            "mailwarn" => Some(self.mailwarn),
            "no_empty_cmd_completion" => Some(self.no_empty_cmd_completion),
            "progcomp" => Some(self.progcomp),
            "promptvars" => Some(self.promptvars),
            "shift_verbose" => Some(self.shift_verbose),
            "sourcepath" => Some(self.sourcepath),
            "xpg_echo" => Some(self.xpg_echo),
            _ => None,
        }
    }

    pub fn shopt_names() -> &'static [&'static str] {
        SHOPT_NAMES
    }

    pub fn enabled_set_o_options(&self) -> Vec<&'static str> {
        let mut result = Vec::new();
        if self.errexit { result.push("errexit"); }
        if self.noclobber { result.push("noclobber"); }
        if self.nounset { result.push("nounset"); }
        if self.pipefail { result.push("pipefail"); }
        if self.posix { result.push("posix"); }
        if self.verbose { result.push("verbose"); }
        if self.xtrace { result.push("xtrace"); }
        result
    }

    pub fn enabled_shopt_options(&self) -> Vec<&'static str> {
        let mut result = Vec::new();
        for &name in SHOPT_NAMES {
            if self.get_shopt(name) == Some(true) {
                result.push(name);
            }
        }
        result
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shopt_names_is_sorted() {
        let names = ShellOptions::shopt_names();
        let mut sorted = names.to_vec();
        sorted.sort();
        assert_eq!(names, sorted.as_slice());
    }

    #[test]
    fn test_set_shopt_valid() {
        let mut opts = ShellOptions::default();
        assert_eq!(opts.get_shopt("extglob"), Some(false));
        let prev = opts.set_shopt("extglob", true);
        assert_eq!(prev, Some(false));
        assert_eq!(opts.get_shopt("extglob"), Some(true));
        let prev = opts.set_shopt("extglob", false);
        assert_eq!(prev, Some(true));
        assert_eq!(opts.get_shopt("extglob"), Some(false));
    }

    #[test]
    fn test_set_shopt_invalid() {
        let mut opts = ShellOptions::default();
        assert_eq!(opts.set_shopt("nonexistent", true), None);
        assert_eq!(opts.get_shopt("nonexistent"), None);
    }

    #[test]
    fn test_enabled_set_o_options() {
        let mut opts = ShellOptions::default();
        assert_eq!(opts.enabled_set_o_options(), Vec::<&str>::new());
        opts.errexit = true;
        opts.pipefail = true;
        let enabled = opts.enabled_set_o_options();
        assert_eq!(enabled, vec!["errexit", "pipefail"]);
    }

    #[test]
    fn test_enabled_shopt_options() {
        let mut opts = ShellOptions::default();
        assert_eq!(opts.enabled_shopt_options(), Vec::<&str>::new());
        opts.extglob = true;
        opts.nullglob = true;
        let enabled = opts.enabled_shopt_options();
        assert_eq!(enabled, vec!["extglob", "nullglob"]);
    }
}
