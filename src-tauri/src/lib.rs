use std::time::Duration;
use tauri::Manager;

#[tauri::command]
async fn report_detail_by_period(
    token: String,
    date_from: String,
    date_to: String,
    limit: Option<u32>,
    rrdid: Option<u64>,
    period: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|err| err.to_string())?;
    let url = "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";
    let mut params: Vec<(&str, String)> = vec![("dateFrom", date_from), ("dateTo", date_to)];
    if let Some(val) = limit {
        params.push(("limit", val.to_string()));
    }
    if let Some(val) = rrdid {
        params.push(("rrdid", val.to_string()));
    }
    if let Some(val) = period {
        params.push(("period", val));
    }

    let res = client
        .get(url)
        .header("Authorization", token)
        .query(&params)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = res.status();
    if status.as_u16() == 204 {
        return Ok(serde_json::Value::Array(vec![]));
    }
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "WB API error {}: {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }

    let text = res.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Array(vec![]));
    }
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

#[tauri::command]
async fn seller_info(token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|err| err.to_string())?;
    let url = "https://common-api.wildberries.ru/api/v1/seller-info";
    let res = client
        .get(url)
        .header("Authorization", token)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "WB API error {}: {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }

    let text = res.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let icon_bytes = include_bytes!("../icons/icon.png");
            if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                if let Some(window) = app.handle().get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            report_detail_by_period,
            seller_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
