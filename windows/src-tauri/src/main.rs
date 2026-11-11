// Tap para Windows — ventana Tauri (WebView2) con la misma interfaz que la de
// Mac. Rust hace lo que hace Swift allí: lanzar yt-dlp, leer su progreso y
// traducirlo a eventos. La diferencia es que aquí yt-dlp y ffmpeg no vienen
// de Homebrew: se descargan la primera vez a %LOCALAPPDATA%\local.tap\bin.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL: &str =
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
/// Cada cuánto se comprueba si hay versión nueva de yt-dlp (las webs cambian a menudo).
const UPDATE_EVERY: u64 = 3 * 24 * 3600;

// MARK: - Procesos sin ventana de consola

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// yt-dlp.exe arranca un segundo proceso (PyInstaller) y lanza ffmpeg: hay que
/// matar el árbol entero, no solo el padre.
fn kill_tree(pid: u32) {
    let _ = command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

// MARK: - Ajustes (carpeta y última actualización de yt-dlp)

#[derive(Default)]
struct Settings {
    folder: Option<PathBuf>,
    updated: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Some(text) = settings_path(app).and_then(|p| fs::read_to_string(p).ok()) else { return Settings::default() };
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Settings {
        folder: value["folder"].as_str().map(PathBuf::from).filter(|p| p.is_dir()),
        updated: value["updated"].as_u64().unwrap_or(0),
    }
}

fn save_settings(app: &AppHandle, settings: &Settings) {
    let Some(path) = settings_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let value = json!({ "folder": settings.folder, "updated": settings.updated });
    let _ = fs::write(path, value.to_string());
}

// MARK: - Estado

struct Job {
    pid: Option<u32>,
    cancelled: bool,
}

struct Engine {
    window: Mutex<Option<WebviewWindow>>,
    jobs: Mutex<HashMap<String, Arc<Mutex<Job>>>>,
    settings: Mutex<Settings>,
    /// Solo una descarga (o actualización) de las herramientas a la vez.
    tools: Mutex<()>,
    /// Tamaño y posición antes de «Alargar», para volver.
    unzoomed: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    pending: Mutex<Vec<String>>,
    /// Idioma elegido en la interfaz (para el diálogo de carpeta).
    english: AtomicBool,
}

impl Engine {
    fn emit(&self, event: Value) {
        if let Some(window) = self.window.lock().unwrap().as_ref() {
            let _ = window.eval(&format!("window.__native && window.__native({event})"));
        }
    }

    fn folder(&self, app: &AppHandle) -> PathBuf {
        self.settings.lock().unwrap().folder.clone().unwrap_or_else(|| {
            app.path().download_dir().unwrap_or_else(|_| app.path().home_dir().unwrap_or_default())
        })
    }
}

/// Las carpetas conocidas van como «@downloads», «@desktop»… y la interfaz las
/// traduce al idioma elegido (en disco se llaman Downloads, Desktop…).
fn display_name(app: &AppHandle, folder: &Path) -> String {
    let paths = app.path();
    let known = [
        (paths.download_dir(), "@downloads"),
        (paths.desktop_dir(), "@desktop"),
        (paths.document_dir(), "@documents"),
        (paths.video_dir(), "@videos"),
        (paths.audio_dir(), "@music"),
        (paths.picture_dir(), "@pictures"),
    ];
    for (dir, name) in known {
        if dir.ok().as_deref() == Some(folder) {
            return name.into();
        }
    }
    folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string_lossy().into_owned())
}

// MARK: - Herramientas: yt-dlp y ffmpeg

fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("Tap")).join("bin")
}

fn tool(app: &AppHandle, name: &str) -> PathBuf {
    bin_dir(app).join(format!("{name}.exe"))
}

/// Descarga `url` en `target` (pasando por un .part), avisando del avance de 0 a 1.
fn fetch(url: &str, target: &Path, progress: &mut dyn FnMut(f64)) -> Result<(), String> {
    let response = ureq::get(url).timeout(Duration::from_secs(60 * 30)).call().map_err(|e| e.to_string())?;
    let total: u64 = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let partial = target.with_extension("part");
    let mut file = File::create(&partial).map_err(|e| e.to_string())?;
    let mut reader = response.into_reader();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        done += read as u64;
        if total > 0 {
            progress(done as f64 / total as f64);
        }
    }
    drop(file);
    fs::rename(&partial, target).map_err(|e| e.to_string())
}

/// Saca ffmpeg.exe y ffprobe.exe de la carpeta bin/ del zip.
fn unzip_ffmpeg(archive: &Path, dir: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(file) = ["ffmpeg.exe", "ffprobe.exe"].into_iter().find(|f| name.ends_with(&format!("/bin/{f}"))) else {
            continue;
        };
        let target = dir.join(file);
        let partial = target.with_extension("part");
        let mut out = File::create(&partial).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Comprueba que estén yt-dlp y ffmpeg y, si falta alguno, lo descarga.
/// Devuelve el código de error que entiende la interfaz si no se puede.
fn ensure_tools(app: &AppHandle, engine: &Engine, id: &str) -> Result<(), &'static str> {
    let _lock = engine.tools.lock().unwrap();
    let dir = bin_dir(app);
    let has_ytdlp = tool(app, "yt-dlp").exists();
    let has_ffmpeg = tool(app, "ffmpeg").exists() && tool(app, "ffprobe").exists();
    if has_ytdlp && has_ffmpeg {
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(|_| "no-ytdlp")?;

    // yt-dlp pesa ~18 MB y el zip de ffmpeg ~130 MB: la barra se reparte 10/90.
    let mut last = -1i64;
    let mut report = |percent: f64| {
        let rounded = percent.floor() as i64;
        if rounded != last {
            last = rounded;
            engine.emit(json!({ "id": id, "type": "tools", "percent": percent }));
        }
    };
    report(0.0);
    if !has_ytdlp {
        fetch(YTDLP_URL, &tool(app, "yt-dlp"), &mut |p| report(p * 10.0)).map_err(|_| "no-ytdlp")?;
        engine.settings.lock().unwrap().updated = now();
        save_settings(app, &engine.settings.lock().unwrap());
    }
    if !has_ffmpeg {
        let archive = dir.join("ffmpeg.zip");
        fetch(FFMPEG_URL, &archive, &mut |p| report(10.0 + p * 88.0)).map_err(|_| "no-ffmpeg")?;
        let unzipped = unzip_ffmpeg(&archive, &dir);
        let _ = fs::remove_file(&archive);
        unzipped.map_err(|_| "no-ffmpeg")?;
        report(100.0);
    }
    Ok(())
}

/// Al abrir la app, si hace días que no se mira, actualiza yt-dlp en segundo plano.
fn update_ytdlp(app: AppHandle) {
    thread::spawn(move || {
        let engine = app.state::<Arc<Engine>>();
        if now().saturating_sub(engine.settings.lock().unwrap().updated) < UPDATE_EVERY {
            return;
        }
        let _lock = engine.tools.lock().unwrap();
        let ytdlp = tool(&app, "yt-dlp");
        if !ytdlp.exists() {
            return;
        }
        if command(&ytdlp).arg("-U").output().map(|o| o.status.success()).unwrap_or(false) {
            engine.settings.lock().unwrap().updated = now();
            save_settings(&app, &engine.settings.lock().unwrap());
        }
    });
}

// MARK: - Motor: una descarga = un proceso de yt-dlp

fn format_arguments(format: &str, quality: &str) -> Vec<String> {
    let args: Vec<&str> = match format {
        "mp3" => {
            let rate = match quality {
                "128" => "128K",
                "192" => "192K",
                _ => "320K",
            };
            vec!["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", rate, "--embed-metadata"]
        }
        "m4a" => match quality {
            // Por debajo de «Original» se parte del audio Opus para poder recodificar al bitrate pedido.
            "64" | "96" => {
                let rate = if quality == "64" { "64K" } else { "96K" };
                vec!["-f", "ba[acodec=opus]/ba/b", "-x", "--audio-format", "m4a", "--audio-quality", rate, "--embed-metadata"]
            }
            _ => vec!["-f", "ba[acodec^=mp4a]/ba/b", "-x", "--audio-format", "m4a", "--embed-metadata"],
        },
        "wav" => {
            let rate = if quality == "48000" { "ExtractAudio:-ar 48000" } else { "ExtractAudio:-ar 44100" };
            vec!["-f", "ba/b", "-x", "--audio-format", "wav", "--postprocessor-args", rate]
        }
        _ => {
            // Primero la resolución pedida y, a igual resolución, H.264 + AAC.
            let container = if format == "mov" { "mov" } else { "mp4" };
            let sort = match quality {
                "480" | "720" | "1080" => format!("res:{quality},vcodec:h264,acodec:aac"),
                _ => "res,vcodec:h264,acodec:aac".into(),
            };
            return ["-S", sort.as_str(), "-f", "bv*+ba/b", "--merge-output-format", container, "--remux-video", container]
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
    };
    args.into_iter().map(String::from).collect()
}

fn download(app: AppHandle, id: String, url: String, format: String, quality: String) {
    let engine = app.state::<Arc<Engine>>().inner().clone();
    let scheme_ok = url.starts_with("http://") || url.starts_with("https://");
    if !scheme_ok {
        engine.emit(json!({ "id": id, "type": "error", "message": "ERROR: Unsupported URL" }));
        return;
    }

    cancel(&engine, &id);
    let job = Arc::new(Mutex::new(Job { pid: None, cancelled: false }));
    engine.jobs.lock().unwrap().insert(id.clone(), job.clone());
    let cancelled = || job.lock().unwrap().cancelled;

    if let Err(code) = ensure_tools(&app, &engine, &id) {
        if !cancelled() {
            engine.jobs.lock().unwrap().remove(&id);
            engine.emit(json!({ "id": id, "type": "error", "message": code }));
        }
        return;
    }
    if cancelled() {
        return;
    }

    let folder = engine.folder(&app);
    let mut arguments: Vec<String> = [
        "--no-playlist", "--no-simulate", "--progress", "--newline", "--no-warnings", "--no-mtime",
        "--encoding", "utf-8",
        "--print", "before_dl:META %(.{title,thumbnail})j",
        "--print", "after_move:FILE %(filepath)s",
        "--progress-template", "download:PROG|%(progress._percent_str)s|%(progress._eta_str)s|%(progress.status)s",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    arguments.push("-o".into());
    arguments.push(folder.join("%(title)s.%(ext)s").to_string_lossy().into_owned());
    arguments.push("--ffmpeg-location".into());
    arguments.push(bin_dir(&app).to_string_lossy().into_owned());
    arguments.extend(format_arguments(&format, &quality));
    arguments.push("--".into());
    arguments.push(url);

    let child = command(tool(&app, "yt-dlp"))
        .args(&arguments)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            engine.jobs.lock().unwrap().remove(&id);
            engine.emit(json!({ "id": id, "type": "error", "message": error.to_string() }));
            return;
        }
    };
    job.lock().unwrap().pid = Some(child.id());

    let stderr = child.stderr.take().unwrap();
    let errors = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let mut part = 0;
    let mut file: Option<String> = None;
    let stdout = child.stdout.take().unwrap();
    for line in BufReader::new(stdout).split(b'\n') {
        let Ok(line) = line else { break };
        let line = String::from_utf8_lossy(&line).trim().to_string();
        if line.is_empty() || cancelled() {
            continue;
        }
        if let Some(meta) = line.strip_prefix("META ") {
            let meta: Value = serde_json::from_str(meta).unwrap_or(Value::Null);
            let mut event = json!({ "id": id, "type": "meta" });
            for key in ["title", "thumbnail"] {
                if let Some(text) = meta[key].as_str() {
                    event[key] = text.into();
                }
            }
            engine.emit(event);
        } else if let Some(path) = line.strip_prefix("FILE ") {
            file = Some(path.to_string());
        } else if line.starts_with("PROG|") {
            let fields: Vec<&str> = line.split('|').map(str::trim).collect();
            if fields.len() < 4 {
                continue;
            }
            if fields[3] == "finished" {
                part += 1;
                engine.emit(json!({ "id": id, "type": "part" }));
            } else if let Ok(percent) = fields[1].trim_end_matches('%').trim().parse::<f64>() {
                engine.emit(json!({ "id": id, "type": "progress", "percent": percent, "eta": fields[2], "part": part }));
            }
        }
    }

    let status = child.wait();
    let errors = errors.join().unwrap_or_default();
    if cancelled() {
        return;
    }
    match (status.map(|s| s.success()).unwrap_or(false), file) {
        (true, Some(file)) => {
            if format == "mp4" || format == "mov" {
                make_playable(&app, &engine, &job, &id, Path::new(&file));
                if cancelled() {
                    return;
                }
            }
            engine.jobs.lock().unwrap().remove(&id);
            let parent = Path::new(&file).parent().map(|p| display_name(&app, p)).unwrap_or_default();
            engine.emit(json!({ "id": id, "type": "done", "path": file, "folder": parent }));
        }
        _ => {
            engine.jobs.lock().unwrap().remove(&id);
            let lines: Vec<&str> = errors.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            let message = lines
                .iter()
                .rev()
                .find(|l| l.starts_with("ERROR"))
                .or(lines.last())
                .map(|l| l.to_string())
                .unwrap_or_else(|| "ERROR: yt-dlp exited with an error".into());
            engine.emit(json!({ "id": id, "type": "error", "message": message }));
        }
    }
}

fn cancel(engine: &Engine, id: &str) {
    let Some(job) = engine.jobs.lock().unwrap().remove(id) else { return };
    let mut job = job.lock().unwrap();
    job.cancelled = true;
    if let Some(pid) = job.pid.take() {
        kill_tree(pid);
    }
}

// MARK: Red de seguridad para vídeo

/// Hay webs que solo sirven VP9, AV1 u Opus (YouTube por encima de 1080p, por
/// ejemplo), que muchos reproductores y editores no abren dentro de un mp4/mov.
/// Si el archivo trae alguno, se recodifica solo esa pista a H.264 / AAC.
/// H.264 y no HEVC: en Windows el códec HEVC es una extensión de pago.
fn make_playable(app: &AppHandle, engine: &Engine, job: &Mutex<Job>, id: &str, file: &Path) {
    let Ok(probe) = command(tool(app, "ffprobe"))
        .args(["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "csv=p=0"])
        .arg(file)
        .output()
    else {
        return;
    };
    let listing = String::from_utf8_lossy(&probe.stdout);
    let (mut video, mut audio) = (None, None);
    for line in listing.lines() {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 2 {
            continue;
        }
        if fields[1] == "video" && video.is_none() && !["mjpeg", "png"].contains(&fields[0]) {
            video = Some(fields[0].to_string());
        }
        if fields[1] == "audio" && audio.is_none() {
            audio = Some(fields[0].to_string());
        }
    }
    let fix_video = video.as_deref().is_some_and(|c| !["h264", "hevc"].contains(&c));
    let fix_audio = audio.as_deref().is_some_and(|c| !["aac", "mp3", "alac", "ac3", "eac3"].contains(&c));
    if !fix_video && !fix_audio {
        return;
    }
    engine.emit(json!({ "id": id, "type": "part" }));

    let extension = file.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    let temporary = file.with_extension(format!("convirtiendo.{extension}"));
    // Primero los codificadores por hardware (NVIDIA, Intel, AMD); si no hay ninguno, la CPU.
    let encoders: &[&[&str]] = if fix_video {
        &[
            &["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "21"],
            &["-c:v", "h264_qsv", "-global_quality", "21"],
            &["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
            &["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
        ]
    } else {
        &[&["-c:v", "copy"]]
    };
    for encoder in encoders {
        if job.lock().unwrap().cancelled {
            break;
        }
        let mut cmd = command(tool(app, "ffmpeg"));
        cmd.args(["-y", "-v", "error", "-i"]).arg(file);
        if video.is_some() {
            cmd.args(["-map", "0:v:0"]);
        }
        if audio.is_some() {
            cmd.args(["-map", "0:a:0"]);
        }
        cmd.args(*encoder);
        if fix_video {
            cmd.args(["-pix_fmt", "yuv420p"]);
        }
        if fix_audio {
            cmd.args(["-c:a", "aac", "-b:a", "192k"]);
        } else {
            cmd.args(["-c:a", "copy"]);
        }
        cmd.args(["-movflags", "+faststart"]).arg(&temporary).stdout(Stdio::null()).stderr(Stdio::null());
        let Ok(mut child) = cmd.spawn() else { break };
        job.lock().unwrap().pid = Some(child.id());
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        job.lock().unwrap().pid = None;
        if ok && temporary.exists() {
            let _ = fs::remove_file(file);
            let _ = fs::rename(&temporary, file);
            return;
        }
        let _ = fs::remove_file(&temporary);
    }
}

// MARK: - Interfaz → Rust

#[tauri::command]
fn bridge(message: Value, app: AppHandle, window: WebviewWindow, engine: State<Arc<Engine>>) {
    let text = |key: &str| message[key].as_str().unwrap_or_default().to_string();
    match message["type"].as_str().unwrap_or_default() {
        "download" => {
            let (id, url) = (text("id"), text("url"));
            let format = Some(text("format")).filter(|f| !f.is_empty()).unwrap_or_else(|| "mp4".into());
            let quality = Some(text("quality")).filter(|q| !q.is_empty()).unwrap_or_else(|| "max".into());
            thread::spawn(move || download(app, id, url, format, quality));
        }
        "cancel" => cancel(&engine, &text("id")),
        "reveal" => {
            let path = text("path");
            if Path::new(&path).exists() {
                let mut cmd = command("explorer");
                #[cfg(windows)]
                cmd.raw_arg(format!("/select,\"{path}\""));
                let _ = cmd.spawn();
            }
        }
        "getFolder" => send_folder(&app, &engine),
        "language" => engine.english.store(text("lang") == "en", Ordering::Relaxed),
        "chooseFolder" => {
            let current = engine.folder(&app);
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title(if engine.english.load(Ordering::Relaxed) {
                    "Choose where downloads are saved"
                } else {
                    "Elige dónde se guardan las descargas"
                })
                .set_directory(current)
                .set_parent(&window)
                .pick_folder(move |picked| {
                    let Some(path) = picked.and_then(|p| p.into_path().ok()).filter(|p| p.is_dir()) else { return };
                    let engine = handle.state::<Arc<Engine>>();
                    engine.settings.lock().unwrap().folder = Some(path);
                    save_settings(&handle, &engine.settings.lock().unwrap());
                    send_folder(&handle, &engine);
                });
        }
        "drag" => {
            let _ = window.start_dragging();
        }
        "minimize" => {
            let _ = window.minimize();
        }
        "close" => {
            let _ = window.close();
        }
        "zoom" => zoom(&window, &engine),
        _ => {}
    }
}

fn send_folder(app: &AppHandle, engine: &Engine) {
    let name = display_name(app, &engine.folder(app));
    engine.emit(json!({ "type": "folder", "name": name }));
}

/// Como el botón verde de Mac: alarga la ventana a todo el alto y vuelve.
fn zoom(window: &WebviewWindow, engine: &Engine) {
    let mut unzoomed = engine.unzoomed.lock().unwrap();
    if let Some((position, size)) = unzoomed.take() {
        let _ = window.set_size(size);
        let _ = window.set_position(position);
        return;
    }
    let (Ok(Some(monitor)), Ok(position), Ok(size)) = (window.current_monitor(), window.outer_position(), window.outer_size())
    else {
        return;
    };
    let area = monitor.work_area();
    *unzoomed = Some((position, size));
    let _ = window.set_position(PhysicalPosition::new(position.x, area.position.y));
    let _ = window.set_size(PhysicalSize::new(size.width, area.size.height));
}

// MARK: - Sistema: acento y Mica

#[cfg(windows)]
fn system_look() -> (Option<String>, bool) {
    use winreg::{enums::*, RegKey};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let accent = user
        .open_subkey("Software\\Microsoft\\Windows\\DWM")
        .and_then(|key| key.get_value::<u32, _>("AccentColor"))
        .ok()
        .map(|abgr| format!("#{:02x}{:02x}{:02x}", abgr & 0xff, (abgr >> 8) & 0xff, (abgr >> 16) & 0xff));
    // Mica existe desde Windows 11 (compilación 22000).
    let build: u32 = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or(0);
    (accent, build >= 22000)
}

#[cfg(not(windows))]
fn system_look() -> (Option<String>, bool) {
    (None, false)
}

// MARK: - App

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Recuerda posición y alto de la ventana entre aperturas, como en Mac.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bridge])
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = Arc::new(Engine {
                window: Mutex::new(None),
                jobs: Mutex::new(HashMap::new()),
                settings: Mutex::new(load_settings(&handle)),
                tools: Mutex::new(()),
                unzoomed: Mutex::new(None),
                english: AtomicBool::new(false),
                // `Tap.exe https://…` deja el enlace en el campo al abrir.
                pending: Mutex::new(
                    std::env::args().skip(1).filter(|a| a.starts_with("http://") || a.starts_with("https://")).collect(),
                ),
            });
            app.manage(engine.clone());

            let (accent, mica) = system_look();
            let look = json!({ "accent": accent, "material": mica });
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Tap")
                // Ancho fijo: la ventana solo crece a lo alto.
                .inner_size(420.0, 540.0)
                .min_inner_size(420.0, 400.0)
                .max_inner_size(420.0, 10_000.0)
                .resizable(true)
                .maximizable(false)
                .decorations(false)
                .shadow(true)
                .transparent(mica)
                .center()
                .initialization_script(&format!("window.__TAP__ = {look};"))
                .on_page_load(|window, payload| {
                    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        return;
                    }
                    let engine = window.state::<Arc<Engine>>();
                    let links = std::mem::take(&mut *engine.pending.lock().unwrap());
                    if !links.is_empty() {
                        let text = Value::String(links.join(" "));
                        let window = window.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(600));
                            let _ = window.eval(&format!("window.__paste && window.__paste({text})"));
                        });
                    }
                });
            if mica {
                builder = builder.effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Mica).build());
            }
            let window = builder.build()?;
            *engine.window.lock().unwrap() = Some(window);
            update_ytdlp(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo arrancar Tap")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let engine = app.state::<Arc<Engine>>();
                let ids: Vec<String> = engine.jobs.lock().unwrap().keys().cloned().collect();
                ids.iter().for_each(|id| cancel(&engine, id));
            }
        });
}
