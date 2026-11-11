import AppKit
import WebKit

// Tap — ventana de cristal nativa con la interfaz (React) dentro de un
// WKWebView. Swift se encarga de la ventana y de lanzar yt-dlp; la interfaz
// le manda mensajes ("download", "cancel"…) y recibe eventos de progreso.

// MARK: - Sirve la interfaz empaquetada en Resources/ui con el esquema app://

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
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

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
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

    private var jobs: [String: Job] = [:]
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
        guard let job = jobs.removeValue(forKey: id) else { return }
        job.cancelled = true
        if job.process.isRunning { job.process.terminate() }
        if let converter = job.converter, converter.isRunning { converter.terminate() }
    }

    func cancelAll() { jobs.keys.forEach(cancel) }

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
