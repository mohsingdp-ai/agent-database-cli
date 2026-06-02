use anyhow::Error;
use regex::Regex;

pub fn mask_secret(value: &str) -> String {
    let patterns = [
        r"(?i)(password=)[^\s&;]+",
        r"(?i)(pwd=)[^\s&;]+",
        r"(?i)(passphrase=)[^\s&;]+",
        r"(?i)(token=)[^\s&;]+",
        r"(?i)(secret=)[^\s&;]+",
        r"(://[^:/\s]+:)[^@\s]+(@)",
    ];
    let mut output = value.to_string();
    for pattern in patterns {
        let re = Regex::new(pattern).expect("masking regex must be valid");
        output = re.replace_all(&output, "$1***$2").to_string();
    }
    output
}

pub fn to_error_message(error: &Error) -> String {
    mask_secret(&error.to_string())
}
