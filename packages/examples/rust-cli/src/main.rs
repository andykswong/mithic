use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("Time went backwards");

    println!("Hello! The time now is: {}", now.as_secs());

    let test_env = std::env::var("TEST").unwrap_or("<null>".into());
    println!("ENV.TEST = \"{}\"", test_env);

    print!("Please enter your name: ");
    std::io::stdout().flush().unwrap();

    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap_or(0);

    if !input.is_empty() {
        // Upper-case the input as a transformation demo
        println!("Hello world, {}!\n", input.trim());
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("Time went backwards");
    println!("Goodbye! The time now is: {}", now.as_secs());
}
