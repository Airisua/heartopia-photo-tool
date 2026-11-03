use crate::{
    config::Config,
    logging::SafeLogger,
    models::{PhotoView, ScanProgress, TaskProgress, UpdateView},
};
use directories::ProjectDirs;
use heartopia_photo_core::{CryptoMaterial, PhotoRecord};
use lru::LruCache;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use tauri_plugin_updater::Update;
use tokio::sync::Semaphore;

#[derive(Default)]
pub struct ScanState {
    pub running: bool,
    pub cancelled: bool,
    pub complete: bool,
    pub cancel: Option<Arc<AtomicBool>>,
    pub progress: Option<ScanProgress>,
    pub records: Vec<PhotoRecord>,
    pub photos: Vec<PhotoView>,
    pub index: HashMap<String, usize>,
    pub input_root: Option<PathBuf>,
    pub output_prefix: String,
}

pub struct FailureRow {
    pub name: String,
    pub relative_path: String,
    pub reason: String,
}

#[derive(Default)]
pub struct TaskState {
    pub running: bool,
    pub cancel: Option<Arc<AtomicBool>>,
    pub progress: Option<TaskProgress>,
    pub failures: Vec<FailureRow>,
}

pub struct UpdateRuntime {
    pub view: UpdateView,
    pub update: Option<Update>,
    pub bytes: Option<Vec<u8>>,
    pub busy: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub version: String,
    pub config_dir: PathBuf,
    pub config: Arc<Mutex<Config>>,
    pub logger: Arc<SafeLogger>,
    pub material: Option<Arc<CryptoMaterial>>,
    pub scan: Arc<Mutex<ScanState>>,
    pub task: Arc<Mutex<TaskState>>,
    pub update: Arc<Mutex<UpdateRuntime>>,
    pub thumbnails: Arc<Mutex<LruCache<String, Arc<String>>>>,
    pub thumbnail_slots: Arc<Semaphore>,
    /// Serialize task creation and directory changes; running work uses its own immutable snapshot.
    pub operation_lock: Arc<Mutex<()>>,
}

impl AppState {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let dirs = ProjectDirs::from("io", "Airisua", "HeartopiaPhotoTool")
            .ok_or("No user data directory available")?;
        let config_dir = dirs.config_dir().to_path_buf();
        let log_dir = dirs.data_local_dir().join("logs");
        let (config, config_warning) = match Config::load(&config_dir) {
            Ok(config) => (config, None),
            Err(message) => (Config::default(), Some(message)),
        };
        let logger = Arc::new(SafeLogger::new(log_dir));
        if let Some(warning) = config_warning {
            logger.add("warn", warning);
        }
        let material = if KEY_AVAILABLE {
            let mut key = KEY_BYTES;
            let mut iv = IV_BYTES;
            let material = CryptoMaterial::new(key, iv);
            key.fill(0);
            iv.fill(0);
            Some(Arc::new(material))
        } else {
            None
        };
        Ok(Self {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            config_dir,
            config: Arc::new(Mutex::new(config)),
            logger,
            material,
            scan: Arc::new(Mutex::new(ScanState::default())),
            task: Arc::new(Mutex::new(TaskState::default())),
            update: Arc::new(Mutex::new(UpdateRuntime {
                view: UpdateView::new("idle", env!("CARGO_PKG_VERSION").to_owned()),
                update: None,
                bytes: None,
                busy: false,
            })),
            thumbnails: Arc::new(Mutex::new(LruCache::new(
                NonZeroUsize::new(600).expect("thumbnail cache size"),
            ))),
            thumbnail_slots: Arc::new(Semaphore::new(2)),
            operation_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn is_busy(&self) -> bool {
        self.scan.lock().running || self.task.lock().running
    }
}

include!(concat!(env!("OUT_DIR"), "/crypto_material.rs"));
