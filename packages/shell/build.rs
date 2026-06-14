fn main() {
    println!("cargo:rustc-env=MITHIC_BUILD_TARGET={}", std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string()));
}
