use crate::types::OutputFormat;
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

pub fn write_output<T: Serialize>(data: &T, format: OutputFormat) -> Result<()> {
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(data)?);
        }
        OutputFormat::Table => {
            println!("{}", format_table(&serde_json::to_value(data)?));
        }
    }
    Ok(())
}

fn format_table(data: &Value) -> String {
    let rows = if let Some(rows) = data.get("rows").and_then(Value::as_array) {
        rows.clone()
    } else if let Some(rows) = data.as_array() {
        rows.clone()
    } else {
        vec![data.clone()]
    };
    if rows.is_empty() {
        return String::new();
    }
    let objects: Vec<serde_json::Map<String, Value>> = rows
        .into_iter()
        .map(|row| {
            row.as_object()
                .cloned()
                .unwrap_or_else(|| serde_json::Map::from_iter([("value".to_string(), row)]))
        })
        .collect();
    let mut columns: Vec<String> = Vec::new();
    for row in &objects {
        for key in row.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    let widths: Vec<usize> = columns
        .iter()
        .map(|column| {
            let cell_width = objects
                .iter()
                .map(|row| stringify_cell(row.get(column)).len())
                .max()
                .unwrap_or(0);
            column.len().max(cell_width)
        })
        .collect();
    let header = columns
        .iter()
        .enumerate()
        .map(|(i, c)| pad(c, widths[i]))
        .collect::<Vec<_>>()
        .join("  ");
    let divider = widths
        .iter()
        .map(|w| "-".repeat(*w))
        .collect::<Vec<_>>()
        .join("  ");
    let body = objects
        .iter()
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| pad(&stringify_cell(row.get(c)), widths[i]))
                .collect::<Vec<_>>()
                .join("  ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    [header, divider, body].join("\n")
}

fn stringify_cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) => value.to_string(),
    }
}

fn pad(value: &str, width: usize) -> String {
    format!("{value:<width$}")
}
