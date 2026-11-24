import AppKit
import WebKit

// Tap — ventana de cristal nativa con la interfaz (React) dentro de un
// WKWebView. Swift se encarga de la ventana y de lanzar yt-dlp; la interfaz
// le manda mensajes ("download", "cancel"…) y recibe eventos de progreso.

// MARK: - Sirve la interfaz empaquetada en Resources/ui con el esquema app://

/// Archivos que la interfaz puede abrir con app://local/__media__ (los que ha
/// descargado, renombrado o recortado esta sesión). Solo se toca en el hilo principal.
enum Media {
    static var allowed = Set<String>()
    static let types = ["mp4": "video/mp4", "mov": "video/quicktime", "m4a": "audio/mp4",
                        "mp3": "audio/mpeg", "wav": "audio/wav"]
}

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private var active = Set<ObjectIdentifier>()
    /// Máximo por respuesta cuando el reproductor pide un rango abierto («bytes=N-»).
    private static let chunk: Int64 = 4 << 20

    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.path == "/__media__" { serveMedia(task, url: url); return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL

        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                     "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "png": "image/png",
                     "json": "application/json", "woff2": "font/woff2"]
        let headers = ["Content-Type": types[file.pathExtension] ?? "application/octet-stream",
                       "Content-Length": String(data.count), "Cache-Control": "no-store"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task as AnyObject))
    }

    /// Sirve un archivo descargado al <video> del editor, con peticiones por rangos
    /// (sin ellas WebKit no puede saltar a otro punto del vídeo).
    private func serveMedia(_ task: WKURLSchemeTask, url: URL) {
        let fail = { task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)) }
        guard let file = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "p" })?.value,
              Media.allowed.contains(file),
              let size = (try? FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value
        else { fail(); return }

        var start: Int64 = 0, end = size - 1, partial = false
        if let header = task.request.value(forHTTPHeaderField: "Range"), header.hasPrefix("bytes=") {
            let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
            let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            if parts.count == 2 {
                partial = true
                if parts[0].isEmpty, let suffix = Int64(parts[1]) {
                    start = max(0, size - suffix)
                } else {
                    start = Int64(parts[0]) ?? 0
                    if let last = Int64(parts[1]) { end = min(last, size - 1) } else { end = min(size - 1, start + Self.chunk - 1) }
                }
            }
        }
        let type = Media.types[(file as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
        guard size > 0, start <= end else {
            let response = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Range": "bytes */\(size)"])!
            task.didReceive(response)
            task.didFinish()
            return
        }

        let key = ObjectIdentifier(task as AnyObject)
        active.insert(key)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var data: Data?
            if let handle = FileHandle(forReadingAtPath: file) {
                try? handle.seek(toOffset: UInt64(start))
                data = try? handle.read(upToCount: Int(end - start + 1))
                try? handle.close()
            }
            DispatchQueue.main.async {
                guard let self, self.active.remove(key) != nil else { return }
                guard let data else { fail(); return }
                var headers = ["Content-Type": type, "Content-Length": String(data.count),
                               "Accept-Ranges": "bytes", "Cache-Control": "no-store"]
                if partial { headers["Content-Range"] = "bytes \(start)-\(start + Int64(data.count) - 1)/\(size)" }
                let response = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200,
                                               httpVersion: "HTTP/1.1", headerFields: headers)!
                task.didReceive(response)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }
}

// MARK: - Nombres de archivo

/// Quita lo que no vale en un nombre de archivo (en Mac y, por si se comparte, en Windows).
func cleanFileName(_ name: String) -> String {
    let banned = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
    let replaced = String(name.unicodeScalars.map { banned.contains($0) ? "-" : Character($0) })
    return String(replaced.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        .prefix(180))
}

/// «carpeta/nombre.ext» y, si ya existe, «nombre 2.ext», «nombre 3.ext»…
func freePath(folder: String, name: String, ext: String) -> String {
    let suffix = ext.isEmpty ? "" : "." + ext
    var candidate = folder + "/" + name + suffix
    var n = 2
    while FileManager.default.fileExists(atPath: candidate) {
        candidate = folder + "/" + name + " \(n)" + suffix
        n += 1
    }
    return candidate
}

// MARK: - Motor: una descarga = un proceso de yt-dlp

/// Nombre de la carpeta para la interfaz. Las conocidas van como «@downloads»,
/// «@desktop»… y la interfaz las traduce al idioma elegido en la app.
func folderLabel(_ path: String) -> String {
    let known: [(FileManager.SearchPathDirectory, String)] = [
        (.downloadsDirectory, "@downloads"), (.desktopDirectory, "@desktop"),
        (.documentDirectory, "@documents"), (.moviesDirectory, "@movies"),
        (.musicDirectory, "@music"), (.picturesDirectory, "@pictures"),
    ]
    let target = URL(fileURLWithPath: path).standardizedFileURL.path
    for (directory, label) in known {
        if let url = FileManager.default.urls(for: directory, in: .userDomainMask).first,
           url.standardizedFileURL.path == target { return label }
    }
    return FileManager.default.displayName(atPath: path)
}

final class Downloader {
    private final class Job {
        let process = Process()
        var buffer = Data()
        var errors = Data()
        var part = 0
        var file: String?
        var cancelled = false
        var isVideo = false
        var converter: Process?
    }

    private final class TrimJob {
        var process: Process?
        var cancelled = false
    }

    private var jobs: [String: Job] = [:]
    private var trims: [String: TrimJob] = [:]
    private let emit: ([String: Any]) -> Void
    var folder = NSHomeDirectory() + "/Downloads"
    private static let searchPaths = ["/opt/homebrew/bin", "/usr/local/bin",
                                      NSHomeDirectory() + "/.local/bin", "/usr/bin", "/bin"]

    init(emit: @escaping ([String: Any]) -> Void) { self.emit = emit }

    private static func find(_ tool: String) -> String? {
        searchPaths.map { $0 + "/" + tool }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func formatArguments(_ format: String, quality: String) -> [String] {
        switch format {
        case "mp3":
            let rate = ["128": "128K", "192": "192K"][quality] ?? "320K"
            return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", rate, "--embed-metadata"]
        case "m4a":
            // Por debajo de «Original» se parte del audio Opus para poder recodificar al bitrate pedido.
            if let rate = ["64": "64K", "96": "96K"][quality] {
                return ["-f", "ba[acodec=opus]/ba/b", "-x", "--audio-format", "m4a",
                        "--audio-quality", rate, "--embed-metadata"]
            }
            return ["-f", "ba[acodec^=mp4a]/ba/b", "-x", "--audio-format", "m4a", "--embed-metadata"]
        case "wav":
            let rate = quality == "48000" ? "48000" : "44100"
            return ["-f", "ba/b", "-x", "--audio-format", "wav", "--postprocessor-args", "ExtractAudio:-ar \(rate)"]
        default:
            // Primero la resolución pedida y, a igual resolución, H.264 + AAC:
            // es lo que abren QuickTime, Finder y los editores sin recodificar.
            let container = format == "mov" ? "mov" : "mp4"
            let cap = ["480", "720", "1080"].contains(quality) ? ":\(quality)" : ""
            return ["-S", "res\(cap),vcodec:h264,acodec:aac", "-f", "bv*+ba/b",
                    "--merge-output-format", container, "--remux-video", container]
        }
    }

    func start(id: String, url: String, format: String, quality: String) {
        cancel(id: id)
        guard let scheme = URL(string: url)?.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            emit(["id": id, "type": "error", "message": "ERROR: Unsupported URL"])
            return
        }
        guard let ytdlp = Self.find("yt-dlp") else {
            emit(["id": id, "type": "error", "message": "no-ytdlp"])
            return
        }

        let job = Job()
        job.isVideo = format == "mp4" || format == "mov"
        var arguments = [
            "--no-playlist", "--no-simulate", "--progress", "--newline", "--no-warnings", "--no-mtime",
            "--print", "before_dl:META %(.{title,thumbnail})j",
            "--print", "after_move:FILE %(filepath)s",
            "--progress-template",
            "download:PROG|%(progress._percent_str)s|%(progress._eta_str)s|%(progress.status)s",
            "-o", folder + "/%(title)s.%(ext)s",
        ]
        if let ffmpeg = Self.find("ffmpeg") {
            arguments += ["--ffmpeg-location", (ffmpeg as NSString).deletingLastPathComponent]
        }
        arguments += Self.formatArguments(format, quality: quality) + ["--", url]

        job.process.executableURL = URL(fileURLWithPath: ytdlp)
        job.process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Self.searchPaths.joined(separator: ":")
        environment["PYTHONUNBUFFERED"] = "1"
        environment["LC_ALL"] = "en_US.UTF-8"
        job.process.environment = environment

        let output = Pipe(), errors = Pipe()
        job.process.standardOutput = output
        job.process.standardError = errors

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data, id: id, job: job) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { job.errors.append(data) }
        }
        job.process.terminationHandler = { [weak self] process in
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            let restOut = output.fileHandleForReading.readDataToEndOfFile()
            let restErr = errors.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self else { return }
                self.consume(restOut + Data("\n".utf8), id: id, job: job)
                job.errors.append(restErr)
                self.finish(id: id, job: job, status: process.terminationStatus)
            }
        }

        jobs[id] = job
        do {
            try job.process.run()
        } catch {
            jobs[id] = nil
            emit(["id": id, "type": "error", "message": error.localizedDescription])
        }
    }

    func cancel(id: String) {
        if let trim = trims.removeValue(forKey: id) {
            trim.cancelled = true
            if let process = trim.process, process.isRunning { process.terminate() }
        }
        guard let job = jobs.removeValue(forKey: id) else { return }
        job.cancelled = true
        if job.process.isRunning { job.process.terminate() }
        if let converter = job.converter, converter.isRunning { converter.terminate() }
    }

    func cancelAll() { (Array(jobs.keys) + Array(trims.keys)).forEach(cancel) }

    // MARK: Recortar

    /// Deja solo [start, end] del archivo. El vídeo se recodifica (con el hardware
    /// de Apple) para que el corte caiga justo donde se pidió y no en el fotograma
    /// clave más cercano; el audio se copia tal cual, que ya es preciso.
    /// Sin `copyName` sustituye el original; con él guarda una copia al lado.
    func trim(id: String, source: String, start: Double, end: Double, copyName: String?) {
        cancel(id: id)
        guard let ffmpeg = Self.find("ffmpeg"), FileManager.default.fileExists(atPath: source) else {
            emit(["id": id, "type": "trimFailed"])
            return
        }
        let job = TrimJob()
        trims[id] = job

        let path = source as NSString
        let ext = path.pathExtension.lowercased()
        let folder = path.deletingLastPathComponent
        let temporary = path.deletingPathExtension + ".recortando." + path.pathExtension
        let video = ext == "mp4" || ext == "mov"
        let length = max(0.1, end - start)
        let ffprobe = Self.find("ffprobe")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var encoders: [[String]] = [["-c", "copy"]]
            if video {
                // Se mantiene la familia del códec: HEVC sigue en HEVC y lo demás pasa a H.264.
                var hevc = false
                if let ffprobe {
                    let probe = Process(), output = Pipe()
                    probe.executableURL = URL(fileURLWithPath: ffprobe)
                    probe.arguments = ["-v", "error", "-select_streams", "v:0", "-show_entries",
                                       "stream=codec_name", "-of", "csv=p=0", source]
                    probe.standardOutput = output
                    probe.standardError = FileHandle.nullDevice
                    if (try? probe.run()) != nil {
                        hevc = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                            .contains("hevc")
                        probe.waitUntilExit()
                    }
                }
                encoders = [hevc ? ["-c:v", "hevc_videotoolbox", "-q:v", "62", "-tag:v", "hvc1"]
                                 : ["-c:v", "h264_videotoolbox", "-q:v", "65"],
                            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]]
            }

            var ok = false
            for encoder in encoders {
                var arguments = ["-y", "-v", "error", "-ss", String(format: "%.3f", start), "-i", source,
                                 "-t", String(format: "%.3f", length)]
                if video {
                    arguments += ["-map", "0:v:0", "-map", "0:a:0?"] + encoder + ["-c:a", "copy"]
                } else {
                    arguments += ["-map", "0:a:0", "-map_metadata", "0"] + encoder
                }
                if ext != "mp3" && ext != "wav" { arguments += ["-movflags", "+faststart"] }
                arguments += ["-progress", "pipe:1", "-nostats", temporary]

                let process = Process(), output = Pipe()
                process.executableURL = URL(fileURLWithPath: ffmpeg)
                process.arguments = arguments
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                var proceed = false
                DispatchQueue.main.sync {
                    guard !job.cancelled else { return }
                    job.process = process
                    proceed = true
                }
                guard proceed, (try? process.run()) != nil else { break }

                var buffer = Data(), last = -1
                while true {
                    let chunk = output.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    while let newline = buffer.firstIndex(of: 0x0A) {
                        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
                        buffer.removeSubrange(buffer.startIndex...newline)
                        guard line.hasPrefix("out_time_us="), let us = Double(line.dropFirst(12)) else { continue }
                        let percent = min(100, max(0, us / 1_000_000 / length * 100))
                        if Int(percent) != last {
                            last = Int(percent)
                            DispatchQueue.main.async {
                                guard !job.cancelled else { return }
                                self?.emit(["id": id, "type": "trimProgress", "percent": percent])
                            }
                        }
                    }
                }
                process.waitUntilExit()
                if process.terminationStatus == 0, FileManager.default.fileExists(atPath: temporary) { ok = true; break }
                try? FileManager.default.removeItem(atPath: temporary)
            }

            DispatchQueue.main.async {
                guard let self else { return }
                let files = FileManager.default
                if job.cancelled {
                    try? files.removeItem(atPath: temporary)
                    return
                }
                self.trims[id] = nil
                guard ok else {
                    try? files.removeItem(atPath: temporary)
                    self.emit(["id": id, "type": "trimFailed"])
                    return
                }
                var target = source
                if let copyName {
                    let name = cleanFileName(copyName)
                    target = freePath(folder: folder, name: name.isEmpty ? "clip" : name, ext: path.pathExtension)
                } else {
                    try? files.removeItem(atPath: source)
                }
                do {
                    try files.moveItem(atPath: temporary, toPath: target)
                    self.emit(["id": id, "type": "done", "path": target, "folder": folderLabel(folder)])
                } catch {
                    try? files.removeItem(atPath: temporary)
                    self.emit(["id": id, "type": "trimFailed"])
                }
            }
        }
    }

    // MARK: Red de seguridad para vídeo

    private static let playableVideo: Set<String> = ["h264", "hevc"]
    private static let playableAudio: Set<String> = ["aac", "mp3", "alac", "ac3", "eac3"]

    /// Hay webs que solo sirven VP9, AV1 u Opus (YouTube por encima de 1080p, por
    /// ejemplo). Dentro de un mp4/mov, QuickTime no los abre: se ve sin imagen o
    /// no se abre. Si el archivo trae alguno, se recodifica solo esa pista.
    private func makePlayable(_ file: String, id: String, job: Job, completion: @escaping () -> Void) {
        guard let ffmpeg = Self.find("ffmpeg"), let ffprobe = Self.find("ffprobe") else { completion(); return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let finish = { DispatchQueue.main.async(execute: completion) }

            let probe = Process(), output = Pipe()
            probe.executableURL = URL(fileURLWithPath: ffprobe)
            probe.arguments = ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "csv=p=0", file]
            probe.standardOutput = output
            probe.standardError = FileHandle.nullDevice
            guard (try? probe.run()) != nil else { finish(); return }
            let listing = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            probe.waitUntilExit()

            var video: String?, audio: String?
            for line in listing.split(separator: "\n") {
                let fields = line.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                guard fields.count >= 2 else { continue }
                if fields[1] == "video", video == nil, !["mjpeg", "png"].contains(fields[0]) { video = fields[0] }
                if fields[1] == "audio", audio == nil { audio = fields[0] }
            }
            let fixVideo = video.map { !Self.playableVideo.contains($0) } ?? false
            let fixAudio = audio.map { !Self.playableAudio.contains($0) } ?? false
            guard fixVideo || fixAudio else { finish(); return }

            let path = file as NSString
            let temporary = path.deletingPathExtension + ".convirtiendo." + path.pathExtension
            var arguments = ["-y", "-v", "error", "-i", file]
            if video != nil { arguments += ["-map", "0:v:0"] }
            if audio != nil { arguments += ["-map", "0:a:0"] }
            arguments += fixVideo ? ["-c:v", "hevc_videotoolbox", "-q:v", "62", "-tag:v", "hvc1"] : ["-c:v", "copy"]
            arguments += fixAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"]
            arguments += ["-movflags", "+faststart", temporary]

            let converter = Process()
            converter.executableURL = URL(fileURLWithPath: ffmpeg)
            converter.arguments = arguments
            converter.standardOutput = FileHandle.nullDevice
            converter.standardError = FileHandle.nullDevice
            var proceed = false
            DispatchQueue.main.sync {
                guard !job.cancelled else { return }
                job.converter = converter
                self?.emit(["id": id, "type": "part"])
                proceed = true
            }
            guard proceed, (try? converter.run()) != nil else { finish(); return }
            converter.waitUntilExit()

            let files = FileManager.default
            if converter.terminationStatus == 0, files.fileExists(atPath: temporary) {
                try? files.removeItem(atPath: file)
                try? files.moveItem(atPath: temporary, toPath: file)
            } else {
                try? files.removeItem(atPath: temporary)
            }
            finish()
        }
    }

    private func consume(_ data: Data, id: String, job: Job) {
        guard !job.cancelled else { return }
        job.buffer.append(data)
        while let newline = job.buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: job.buffer[job.buffer.startIndex..<newline], as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            job.buffer.removeSubrange(job.buffer.startIndex...newline)
            if !line.isEmpty { handle(line, id: id, job: job) }
        }
    }

    private func handle(_ line: String, id: String, job: Job) {
        if line.hasPrefix("META ") {
            let json = Data(line.dropFirst(5).utf8)
            guard let meta = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return }
            var event: [String: Any] = ["id": id, "type": "meta"]
            if let title = meta["title"] as? String { event["title"] = title }
            if let thumbnail = meta["thumbnail"] as? String { event["thumbnail"] = thumbnail }
            emit(event)
        } else if line.hasPrefix("FILE ") {
            job.file = String(line.dropFirst(5))
        } else if line.hasPrefix("PROG|") {
            let fields = line.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard fields.count >= 4 else { return }
            if fields[3] == "finished" {
                job.part += 1
                emit(["id": id, "type": "part"])
            } else if let percent = Double(fields[1].replacingOccurrences(of: "%", with: "")) {
                emit(["id": id, "type": "progress", "percent": percent, "eta": fields[2], "part": job.part])
            }
        }
    }

    private func finish(id: String, job: Job, status: Int32) {
        guard !job.cancelled else { return }
        if status == 0, let file = job.file {
            let done = { [weak self] in
                guard let self, !job.cancelled else { return }
                self.jobs[id] = nil
                let parent = (file as NSString).deletingLastPathComponent
                self.emit(["id": id, "type": "done", "path": file,
                           "folder": folderLabel(parent)])
            }
            if job.isVideo { makePlayable(file, id: id, job: job, completion: done) } else { done() }
            return
        }
        jobs[id] = nil
        let lines = String(decoding: job.errors, as: UTF8.self).split(separator: "\n").map(String.init)
        let message = lines.last { $0.hasPrefix("ERROR") } ?? lines.last ?? "ERROR: yt-dlp exited with code \(status)"
        emit(["id": id, "type": "error", "message": message])
    }
}

// MARK: - Franja superior para arrastrar la ventana

final class DragStrip: NSView {
    static let height: CGFloat = 56

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var downloader: Downloader!
    private var pendingLinks: [String] = []
    private var pageReady = false
    private var english = !(Locale.preferredLanguages.first ?? "en").hasPrefix("es")

    /// Texto en el idioma elegido en la interfaz.
    private func tr(_ es: String, _ en: String) -> String { english ? en : es }

    func applicationDidFinishLaunching(_ notification: Notification) {
        downloader = Downloader { [weak self] event in self?.send(event) }
        buildMenu()

        let configuration = WKWebViewConfiguration()
        let ui = Bundle.main.resourceURL!.appendingPathComponent("ui")
        configuration.setURLSchemeHandler(BundleSchemeHandler(root: ui), forURLScheme: "app")
        configuration.userContentController.add(self, name: "ytdlp")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsMagnification = false
        if #available(macOS 13.3, *) {
            webView.isInspectable = ProcessInfo.processInfo.environment["YTDLP_PLUS_DEBUG"] != nil
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 540),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Tap"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        // Ancho fijo: la ventana solo crece a lo alto.
        window.minSize = NSSize(width: 420, height: 400)
        window.maxSize = NSSize(width: 420, height: 10_000)
        window.isReleasedWhenClosed = false
        // Sin pantalla completa: el botón verde muestra «+» y solo alarga la ventana.
        window.collectionBehavior = [.fullScreenNone]

        let content = NSView()
        webView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(webView)
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(strip)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            strip.topAnchor.constraint(equalTo: content.topAnchor),
            strip.heightAnchor.constraint(equalToConstant: DragStrip.height),
        ])

        // Cristal líquido en macOS 26 o posterior; desenfoque clásico en los anteriores.
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.contentView = content
            window.contentView = glass
        } else {
            let blur = NSVisualEffectView()
            blur.material = .hudWindow
            blur.blendingMode = .behindWindow
            blur.state = .active
            content.translatesAutoresizingMaskIntoConstraints = false
            blur.addSubview(content)
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
                content.topAnchor.constraint(equalTo: blur.topAnchor),
                content.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            ])
            window.contentView = blur
        }

        window.center()
        window.setFrameAutosaveName("Tap")
        var frame = window.frame
        frame.size.width = 420
        window.setFrame(frame, display: false)
        // La carpeta elegida; si no hay, la que se eligió con los nombres anteriores de la app.
        let saved = UserDefaults.standard.string(forKey: "folder")
            ?? UserDefaults(suiteName: "local.caudal")?.string(forKey: "folder")
            ?? UserDefaults(suiteName: "local.ytdlpplus")?.string(forKey: "folder")
        if let saved { useFolder(saved) }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)

        // `open -a Tap --args https://…` empieza a descargar al abrir.
        pendingLinks = CommandLine.arguments.dropFirst().filter { $0.hasPrefix("http://") || $0.hasPrefix("https://") }
        webView.load(URLRequest(url: URL(string: "app://local/index.html")!))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { downloader.cancelAll() }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: Interfaz → Swift

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "download":
            guard let id = body["id"] as? String, let url = body["url"] as? String else { return }
            downloader.start(id: id, url: url, format: body["format"] as? String ?? "mp4",
                             quality: body["quality"] as? String ?? "max")
        case "cancel":
            if let id = body["id"] as? String { downloader.cancel(id: id) }
        case "reveal":
            guard let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        case "rename":
            guard let id = body["id"] as? String, let path = body["path"] as? String,
                  let name = body["name"] as? String else { return }
            rename(id: id, path: path, name: name)
        case "trim":
            guard let id = body["id"] as? String, let path = body["path"] as? String, Media.allowed.contains(path),
                  let start = (body["start"] as? NSNumber)?.doubleValue,
                  let end = (body["end"] as? NSNumber)?.doubleValue, end > start
            else {
                if let id = body["id"] as? String { send(["id": id, "type": "trimFailed"]) }
                return
            }
            downloader.trim(id: id, source: path, start: start, end: end, copyName: body["copyName"] as? String)
        case "getFolder":
            sendFolder()
        case "chooseFolder":
            chooseFolder()
        case "language":
            let next = (body["lang"] as? String) == "en"
            if next != english {
                english = next
                buildMenu()
            }
        case "drag":
            if let event = NSApp.currentEvent, event.type == .leftMouseDown { window.performDrag(with: event) }
        default:
            break
        }
    }

    // MARK: Cambiar el nombre

    /// Cambia el nombre (sin la extensión) del archivo ya descargado.
    private func rename(id: String, path: String, name raw: String) {
        let name = cleanFileName(raw)
        let files = FileManager.default
        guard !name.isEmpty, Media.allowed.contains(path), files.fileExists(atPath: path) else {
            send(["id": id, "type": "renameFailed"])
            return
        }
        let file = path as NSString
        let folder = file.deletingLastPathComponent
        let current = (file.lastPathComponent as NSString).deletingPathExtension
        if name == current {
            send(["id": id, "type": "renamed", "path": path, "name": name])
            return
        }
        // Si solo cambian mayúsculas, el disco lo ve como el mismo archivo: no se busca hueco.
        let suffix = file.pathExtension.isEmpty ? "" : "." + file.pathExtension
        let target = name.lowercased() == current.lowercased()
            ? folder + "/" + name + suffix
            : freePath(folder: folder, name: name, ext: file.pathExtension)
        do {
            try files.moveItem(atPath: path, toPath: target)
            Media.allowed.remove(path)
            send(["id": id, "type": "renamed", "path": target, "name": ((target as NSString).lastPathComponent as NSString).deletingPathExtension])
        } catch {
            send(["id": id, "type": "renameFailed"])
        }
    }

    // MARK: Carpeta de destino

    private func useFolder(_ path: String) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else { return }
        downloader.folder = path
    }

    private func sendFolder() {
        send(["type": "folder", "name": folderLabel(downloader.folder)])
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: downloader.folder)
        panel.prompt = tr("Guardar aquí", "Save Here")
        panel.message = tr("Elige dónde se guardan las descargas", "Choose where downloads are saved")
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.useFolder(url.path)
            UserDefaults.standard.set(self.downloader.folder, forKey: "folder")
            self.sendFolder()
        }
    }

    // MARK: Swift → interfaz

    private func send(_ event: [String: Any]) {
        if let path = event["path"] as? String { Media.allowed.insert(path) }
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__native && window.__native(\(json))", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        guard !pendingLinks.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: [pendingLinks.joined(separator: " ")]),
              let json = String(data: data, encoding: .utf8) else { return }
        pendingLinks = []
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            webView.evaluateJavaScript("window.__paste && window.__paste(\(json)[0])", completionHandler: nil)
        }
    }

    // La ventana solo muestra la interfaz: cualquier otro enlace no navega.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.scheme == "app" ? .allow : .cancel)
    }

    // MARK: Menú (sin él no funcionan ⌘V, ⌘C, ⌘Q…)

    private func buildMenu() {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: tr("Acerca de Tap", "About Tap"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: tr("Ocultar Tap", "Hide Tap"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: tr("Ocultar otros", "Hide Others"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(.separator())
        app.addItem(withTitle: tr("Salir de Tap", "Quit Tap"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let edit = NSMenu(title: tr("Edición", "Edit"))
        edit.addItem(withTitle: tr("Deshacer", "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: tr("Rehacer", "Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: tr("Cortar", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: tr("Copiar", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: tr("Pegar", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: tr("Seleccionar todo", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windowMenu = NSMenu(title: tr("Ventana", "Window"))
        windowMenu.addItem(withTitle: tr("Minimizar", "Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: tr("Cerrar", "Close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        for menu in [app, edit, windowMenu] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
