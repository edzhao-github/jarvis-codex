use serde::{Deserialize, Serialize};
const SERVICE: &str = "com.bigguan.meowvis-desktop";
const ACCOUNT: &str = "provider-api-keys";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeys {
    pub qwen: String,
    pub deepseek: String,
}
impl ApiKeys {
    fn validate(&self) -> Result<(), String> {
        for value in [&self.qwen, &self.deepseek] {
            if !value.starts_with("sk-")
                || value.len() > 4096
                || value.chars().any(char::is_whitespace)
            {
                return Err("请填写有效的千问和 DeepSeek 密钥".into());
            }
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
pub fn load() -> Result<ApiKeys, String> {
    match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "钥匙串中的密钥格式无效，请重新保存".into())
        }
        Err(error) if error.code() == -25300 => Ok(ApiKeys::default()),
        Err(error) => Err(format!("无法读取 macOS 钥匙串（错误码 {}）", error.code())),
    }
}
#[cfg(target_os = "macos")]
pub fn save(keys: ApiKeys) -> Result<(), String> {
    keys.validate()?;
    let bytes = serde_json::to_vec(&keys).map_err(|_| "无法编码密钥".to_owned())?;
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, &bytes)
        .map_err(|error| format!("无法保存到 macOS 钥匙串（错误码 {}）", error.code()))
}
#[cfg(not(target_os = "macos"))]
pub fn load() -> Result<ApiKeys, String> {
    Err("当前平台尚未提供安全密钥存储".into())
}
#[cfg(not(target_os = "macos"))]
pub fn save(_keys: ApiKeys) -> Result<(), String> {
    Err("当前平台尚未提供安全密钥存储".into())
}

#[tauri::command]
pub async fn load_api_keys() -> Result<ApiKeys, String> {
    tokio::task::spawn_blocking(load)
        .await
        .map_err(|_| "钥匙串读取任务失败".to_owned())?
}
#[tauri::command]
pub async fn save_api_keys(keys: ApiKeys) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save(keys))
        .await
        .map_err(|_| "钥匙串保存任务失败".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_errors_never_echo_credentials() {
        let keys = ApiKeys {
            qwen: "invalid-secret".into(),
            deepseek: "sk-test".into(),
        };
        let error = keys.validate().unwrap_err();
        assert!(!error.contains("invalid-secret"));
        assert!(ApiKeys {
            qwen: "sk-test".into(),
            deepseek: "sk-other".into()
        }
        .validate()
        .is_ok());
    }
}
