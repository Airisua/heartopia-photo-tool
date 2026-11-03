use crate::models::{AppView, DirectoryView, Filters};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SavedDirectory {
    pub token: String,
    pub path: PathBuf,
}

impl Default for SavedDirectory {
    fn default() -> Self {
        Self {
            token: Uuid::new_v4().to_string(),
            path: PathBuf::new(),
        }
    }
}

impl SavedDirectory {
    pub fn new(path: PathBuf) -> Self {
        Self {
            token: Uuid::new_v4().to_string(),
            path,
        }
    }
    pub fn view(&self) -> DirectoryView {
        let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let is_user_directory = profile.as_ref().is_some_and(|profile| {
            self.path == *profile
                || self.path.file_name() == profile.file_name()
                || self.path == profile.join("AppData")
        });
        DirectoryView {
            token: self.token.clone(),
            label: if is_user_directory {
                "用户目录（已隐藏）".to_owned()
            } else {
                self.path
                    .file_name()
                    .map(|v| v.to_string_lossy().into_owned())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| "所选目录".into())
            },
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub schema_version: u32,
    pub input: Option<SavedDirectory>,
    pub output: Option<SavedDirectory>,
    pub recent_inputs: Vec<SavedDirectory>,
    pub recent_outputs: Vec<SavedDirectory>,
    pub filters: Filters,
    pub conflict_policy: String,
    pub workers: u8,
    pub auto_check_updates: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 1,
            input: None,
            output: None,
            recent_inputs: Vec::new(),
            recent_outputs: Vec::new(),
            filters: Filters::default(),
            conflict_policy: "skip".into(),
            workers: 2,
            auto_check_updates: true,
        }
    }
}

impl Config {
    pub fn load(directory: &Path) -> Result<Self, &'static str> {
        let path = directory.join("settings.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        let meta = fs::metadata(&path).map_err(|_| "配置文件暂时不可访问，已使用默认设置")?;
        if meta.len() > 1_048_576 {
            return Err("配置文件异常，已使用默认设置");
        }
        let bytes = fs::read(&path).map_err(|_| "配置文件暂时不可访问，已使用默认设置")?;
        let mut config: Self =
            serde_json::from_slice(&bytes).map_err(|_| "配置文件格式异常，已使用默认设置")?;
        config.workers = config.workers.clamp(1, 8);
        if !matches!(config.conflict_policy.as_str(), "skip" | "rename") {
            config.conflict_policy = "skip".into();
        }
        validate_filters(&config.filters).map_err(|_| "筛选配置异常，已使用默认设置")?;
        config.recent_inputs.truncate(8);
        config.recent_outputs.truncate(8);
        Ok(config)
    }

    pub fn save(&self, directory: &Path) -> Result<(), &'static str> {
        fs::create_dir_all(directory).map_err(|_| "无法创建用户配置目录")?;
        let json = serde_json::to_vec_pretty(self).map_err(|_| "无法保存设置")?;
        let mut temp =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| "无法写入用户设置")?;
        temp.write_all(&json).map_err(|_| "无法写入用户设置")?;
        temp.as_file().sync_all().map_err(|_| "无法完成设置写入")?;
        temp.persist(directory.join("settings.json"))
            .map_err(|_| "无法提交用户设置")?;
        Ok(())
    }

    pub fn view(&self, version: String, key_available: bool) -> AppView {
        AppView {
            version,
            input: self.input.as_ref().map(SavedDirectory::view),
            output: self.output.as_ref().map(SavedDirectory::view),
            recent_inputs: self
                .recent_inputs
                .iter()
                .map(SavedDirectory::view)
                .collect(),
            recent_outputs: self
                .recent_outputs
                .iter()
                .map(SavedDirectory::view)
                .collect(),
            filters: self.filters.clone(),
            conflict_policy: self.conflict_policy.clone(),
            workers: self.workers,
            auto_check_updates: self.auto_check_updates,
            key_available,
        }
    }

    pub fn set_directory(&mut self, kind: &str, path: PathBuf) -> Result<(), &'static str> {
        let (current, recent) = match kind {
            "input" => (&mut self.input, &mut self.recent_inputs),
            "output" => (&mut self.output, &mut self.recent_outputs),
            _ => return Err("目录类型无效"),
        };
        let entry = recent
            .iter()
            .find(|e| e.path == path)
            .cloned()
            .unwrap_or_else(|| SavedDirectory::new(path));
        recent.retain(|e| e.token != entry.token);
        recent.insert(0, entry.clone());
        recent.truncate(8);
        *current = Some(entry);
        Ok(())
    }
}

pub fn validate_filters(filters: &Filters) -> Result<(), &'static str> {
    for date in [&filters.start_date, &filters.end_date] {
        if !date.is_empty()
            && (date.len() != 10 || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err())
        {
            return Err("日期格式应为 YYYY-MM-DD");
        }
    }
    if !filters.start_date.is_empty()
        && !filters.end_date.is_empty()
        && filters.start_date > filters.end_date
    {
        return Err("开始日期不能晚于结束日期");
    }
    if !matches!(
        filters.date_preset.as_str(),
        "all" | "today" | "7d" | "30d" | "custom"
    ) {
        return Err("日期快捷选项无效");
    }
    if filters.directory.len() > 512 || filters.query.len() > 512 {
        return Err("筛选内容过长");
    }
    for value in [&filters.directory, &filters.query] {
        if value.contains(":\\") || value.contains(":/") || value.starts_with("\\\\") {
            return Err("筛选只接受文件名或相对路径，不接受完整用户目录");
        }
    }
    if !matches!(
        filters.extension.to_lowercase().as_str(),
        "" | "jpg" | "jpeg" | "png"
    ) {
        return Err("图片类型无效");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_keeps_private_paths_but_view_never_contains_them() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config
            .set_directory(
                "input",
                PathBuf::from(r"C:\Users\PRIVATE_TEST_USER\照片\ScreenCapture"),
            )
            .unwrap();
        config
            .set_directory("output", PathBuf::from(r"D:\导出\已解密"))
            .unwrap();
        config.filters.date_preset = "7d".into();
        config.workers = 4;
        config.save(dir.path()).unwrap();
        let restored = Config::load(dir.path()).unwrap();
        assert_eq!(
            restored.input.as_ref().unwrap().path,
            config.input.as_ref().unwrap().path
        );
        assert_eq!(restored.filters, config.filters);
        assert_eq!(restored.workers, 4);
        let exposed = serde_json::to_string(&restored.view("0.1.0".into(), true)).unwrap();
        assert!(!exposed.contains("PRIVATE_TEST_USER"));
        assert!(!exposed.contains("C:"));
    }
    #[test]
    fn recent_list_is_bounded_and_selection_keeps_token() {
        let mut config = Config::default();
        for i in 0..20 {
            config
                .set_directory("input", PathBuf::from(format!("D:/sample/{i}")))
                .unwrap();
        }
        assert_eq!(config.recent_inputs.len(), 8);
        let last = config.input.as_ref().unwrap().clone();
        config.set_directory("input", last.path).unwrap();
        assert_eq!(config.input.as_ref().unwrap().token, last.token);
    }
    #[test]
    fn corrupt_settings_and_reversed_dates_are_not_accepted() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), b"{broken").unwrap();
        assert!(Config::load(dir.path()).is_err());
        let f = Filters {
            start_date: "2026-11-04".into(),
            end_date: "2026-11-03".into(),
            ..Default::default()
        };
        assert!(validate_filters(&f).is_err());
    }

    #[test]
    fn selecting_profile_never_displays_the_username() {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let saved = SavedDirectory::new(PathBuf::from(profile));
            assert_eq!(saved.view().label, "用户目录（已隐藏）");
        }
    }
}
