export function getBashrc(mode: string, baseUrl?: string): string {
  const switchMode = mode === 'worker' ? 'async' : 'worker';
  const switchLabel = mode === 'worker' ? 'Async (no Workers)' : 'Worker (parallel)';
  const switchUrl = baseUrl ? `${baseUrl}?mode=${switchMode}` : `?mode=${switchMode}`;
  return `
echo -e ""
echo -e "  \\033[1;35m███╗   ███╗██╗████████╗██╗  ██╗██╗ ██████╗\\033[0m"
echo -e "  \\033[1;35m████╗ ████║██║╚══██╔══╝██║  ██║██║██╔════╝\\033[0m"
echo -e "  \\033[1;35m██╔████╔██║██║   ██║   ███████║██║██║     \\033[0m"
echo -e "  \\033[1;35m██║╚██╔╝██║██║   ██║   ██╔══██║██║██║     \\033[0m"
echo -e "  \\033[1;35m██║ ╚═╝ ██║██║   ██║   ██║  ██║██║╚██████╗\\033[0m"
echo -e "  \\033[1;35m╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝ ╚═════╝\\033[0m"
echo -e ""
echo -e "\\033[2mSandboxed WebAssembly bash/POSIX-compatible shell runtime with concurrent\\033[0m"
echo -e "\\033[2mprocess management, capability-based virtual filesystem and resource access.\\033[0m"
echo -e "\\033[2mRuns anywhere JavaScript runs.\\033[0m"
echo -e ""
echo -e "  \\033[1;36mnpm install mithic\\033[0m"
echo -e ""
echo -e "\\033[2mLinks:\\033[0m \\033]8;;https://github.com/andykswong/mithic\\007\\033[4;36mGitHub\\033[0m\\033]8;;\\007  \\033]8;;https://andykswong.github.io/mithic/api\\007\\033[4;36mAPI Docs\\033[0m\\033]8;;\\007"
echo -e "\\033[2mMode:\\033[0m \\033[1;33m${mode}\\033[0m  \\033]8;;${switchUrl}\\007\\033[4;36m[Switch to ${switchLabel}]\\033[0m\\033]8;;\\007"
echo -e ""
echo -e "\\033[2mTry:\\033[0m \\033[36mls /bin\\033[0m, \\033[36mecho hello | tr a-z A-Z\\033[0m, \\033[36mcat /dev/urandom | head -c 8 | base64\\033[0m, \\033[36m/bin/rust-component\\033[0m"
echo -e ""
export PS1="\\e[1;32m\\w\\e[0m\\$ "
`;
}
