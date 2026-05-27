/// <reference types="vite/client" />

declare module '@mithic/example-rust-cli/component' {
  export const modules: Record<string, string>;
  export function instantiate(
    compileCore: (path: string) => Promise<WebAssembly.Module>,
    imports: object
  ): Promise<{ run: { run(): void } }>;
}
