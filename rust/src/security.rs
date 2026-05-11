use crate::types::{DatabaseConfig, DatabaseType};
use anyhow::Result;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

static SQL_READ_COMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    ["select", "show", "describe", "desc", "explain", "with"]
        .into_iter()
        .collect()
});
static SQL_WRITE_COMMANDS: &[&str] = &[
    "insert", "update", "delete", "merge", "replace", "drop", "truncate", "alter", "create",
    "grant", "revoke",
];
static REDIS_READ_COMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "get",
        "mget",
        "exists",
        "ttl",
        "pttl",
        "type",
        "strlen",
        "keys",
        "scan",
        "hget",
        "hgetall",
        "hmget",
        "hexists",
        "hlen",
        "hkeys",
        "hvals",
        "lrange",
        "llen",
        "lindex",
        "smembers",
        "scard",
        "sismember",
        "zrange",
        "zrevrange",
        "zcard",
        "zscore",
    ]
    .into_iter()
    .collect()
});
static MONGO_READ_COMMANDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "find",
        "findOne",
        "aggregate",
        "count",
        "countDocuments",
        "estimatedDocumentCount",
        "distinct",
    ]
    .into_iter()
    .collect()
});

pub fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn get_command_head(command: &str, db_type: &DatabaseType) -> Result<String> {
    let normalized = normalize_command(command);
    if *db_type == DatabaseType::Mongodb {
        return Ok(get_mongo_command_name(&normalized)?.to_lowercase());
    }
    Ok(normalized
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches(';')
        .to_lowercase())
}

pub fn assert_command_allowed(config: &DatabaseConfig, command: &str) -> Result<()> {
    let normalized = normalize_command(command);
    let head = get_command_head(&normalized, &config.db_type)?;
    assert_not_blacklisted(config, &normalized, &head)?;
    // 默认只读，只有显式 readonly=false 才允许写操作。
    if config.readonly.unwrap_or(true) && !is_read_only_command(&config.db_type, &normalized)? {
        let rejected = if head.is_empty() { normalized } else { head };
        anyhow::bail!("只读模式拒绝执行命令: {rejected}");
    }
    Ok(())
}

fn assert_not_blacklisted(config: &DatabaseConfig, normalized: &str, head: &str) -> Result<()> {
    let command_for_blacklist = if is_sql_database(&config.db_type) {
        strip_sql_literals_and_comments(normalized)
    } else {
        normalized.to_string()
    };
    for item in config.blacklist.as_deref().unwrap_or(&[]) {
        let black = normalize_command(item).to_lowercase();
        if black.is_empty() {
            continue;
        }
        if head == black || has_blacklisted_keyword(&command_for_blacklist, &black) {
            anyhow::bail!("黑名单拒绝执行命令: {item}");
        }
    }
    Ok(())
}

fn has_blacklisted_keyword(command: &str, keyword: &str) -> bool {
    let escaped = regex::escape(keyword).replace(r"\ ", r"\s+");
    let re = Regex::new(&format!(
        r"(?i)(^|[^\p{{L}}\p{{N}}_$]){}($|[^\p{{L}}\p{{N}}_$])",
        escaped
    ))
    .expect("黑名单正则必须合法");
    re.is_match(command)
}

fn is_sql_database(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::Oracle
    )
}

pub fn is_read_only_command(db_type: &DatabaseType, command: &str) -> Result<bool> {
    let head = get_command_head(command, db_type)?;
    match db_type {
        DatabaseType::Redis => Ok(REDIS_READ_COMMANDS.contains(head.as_str())),
        DatabaseType::Mongodb => {
            Ok(MONGO_READ_COMMANDS.contains(get_mongo_command_name(command)?.as_str()))
        }
        DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::Oracle => {
            if !SQL_READ_COMMANDS.contains(head.as_str()) {
                return Ok(false);
            }
            let sanitized = strip_sql_literals_and_comments(command);
            Ok(!SQL_WRITE_COMMANDS
                .iter()
                .any(|keyword| has_blacklisted_keyword(&sanitized, keyword)))
        }
    }
}

fn strip_sql_literals_and_comments(command: &str) -> String {
    let chars: Vec<char> = command.chars().collect();
    let mut result = String::new();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        if (char == 'q' || char == 'Q') && next == Some('\'') {
            if let Some(end) = find_oracle_quoted_literal_end(&chars, index) {
                push_spaces(&mut result, end - index);
                index = end;
                continue;
            }
        }
        if char == '-' && next == Some('-') {
            let end = find_line_end(&chars, index + 2);
            push_spaces(&mut result, end - index);
            index = end;
            continue;
        }
        if char == '#' {
            let end = find_line_end(&chars, index + 1);
            push_spaces(&mut result, end - index);
            index = end;
            continue;
        }
        if char == '/' && next == Some('*') {
            let end = find_block_comment_end(&chars, index + 2);
            push_spaces(&mut result, end - index);
            index = end;
            continue;
        }
        if char == '\'' || char == '"' || char == '`' {
            let end = find_quoted_token_end(&chars, index, char, char);
            push_spaces(&mut result, end - index);
            index = end;
            continue;
        }
        if char == '[' {
            let end = find_quoted_token_end(&chars, index, '[', ']');
            push_spaces(&mut result, end - index);
            index = end;
            continue;
        }
        result.push(char);
        index += 1;
    }
    result
}

fn push_spaces(result: &mut String, count: usize) {
    result.extend(std::iter::repeat(' ').take(count));
}

fn find_line_end(chars: &[char], start: usize) -> usize {
    chars[start..]
        .iter()
        .position(|c| *c == '\n')
        .map(|offset| start + offset)
        .unwrap_or(chars.len())
}

fn find_block_comment_end(chars: &[char], start: usize) -> usize {
    let mut index = start;
    while index + 1 < chars.len() {
        if chars[index] == '*' && chars[index + 1] == '/' {
            return index + 2;
        }
        index += 1;
    }
    chars.len()
}

fn find_quoted_token_end(chars: &[char], start: usize, _open: char, close: char) -> usize {
    let mut index = start + 1;
    while index < chars.len() {
        if chars[index] == close {
            if chars.get(index + 1) == Some(&close) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        if chars[index] == '\\' && close != ']' {
            index += 2;
            continue;
        }
        index += 1;
    }
    chars.len()
}

fn find_oracle_quoted_literal_end(chars: &[char], start: usize) -> Option<usize> {
    let open = *chars.get(start + 2)?;
    let close = match open {
        '[' => ']',
        '(' => ')',
        '{' => '}',
        '<' => '>',
        other => other,
    };
    let mut index = start + 3;
    while index + 1 < chars.len() {
        if chars[index] == close && chars[index + 1] == '\'' {
            return Some(index + 2);
        }
        index += 1;
    }
    None
}

fn get_mongo_command_name(command: &str) -> Result<String> {
    let parsed: Value = serde_json::from_str(command)
        .map_err(|_| anyhow::anyhow!("MongoDB 命令必须是合法 JSON"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("MongoDB 命令必须是对象"))?;
    object
        .keys()
        .next()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("MongoDB 命令 JSON 不能为空"))
}
