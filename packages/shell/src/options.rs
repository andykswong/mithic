#[derive(Clone, Default)]
pub(crate) struct ShellOptions {
    pub errexit: bool,  // -e: exit on non-zero status
    pub nounset: bool,  // -u: error on unset variable expansion
    pub pipefail: bool, // -o pipefail: pipeline fails if any command fails
    pub xtrace: bool,   // -x: print commands before execution
}

impl ShellOptions {
    pub fn set_flag(&mut self, flag: char, enable: bool) -> bool {
        match flag {
            'e' => { self.errexit = enable; true }
            'u' => { self.nounset = enable; true }
            'x' => { self.xtrace = enable; true }
            _ => false,
        }
    }

    pub fn set_o_flag(&mut self, name: &str, enable: bool) -> bool {
        match name {
            "errexit" => { self.errexit = enable; true }
            "nounset" => { self.nounset = enable; true }
            "pipefail" => { self.pipefail = enable; true }
            "xtrace" => { self.xtrace = enable; true }
            _ => false,
        }
    }
}
