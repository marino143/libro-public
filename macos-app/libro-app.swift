import Cocoa
import WebKit

let DASHBOARD_URL = "http://localhost:8765/dashboard.html"
let STATUS_URL = "http://localhost:8765/api/status"
let LAUNCHD_PLIST = NSHomeDirectory() + "/Library/LaunchAgents/app.libro.server.plist"

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureServerUp()
        buildMenu()
        buildWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // MARK: - Server lifecycle

    func ensureServerUp() {
        if checkServer() { return }
        // Try launchd
        let task = Process()
        task.launchPath = "/bin/launchctl"
        task.arguments = ["load", "-w", LAUNCHD_PLIST]
        try? task.run()
        task.waitUntilExit()
        // Poll do 15s
        for _ in 0..<15 {
            sleep(1)
            if checkServer() { return }
        }
        // Show error dialog
        let alert = NSAlert()
        alert.messageText = "libro-server nije dostupan"
        alert.informativeText = "Server nije se mogao pokrenuti na localhost:8765.\n\nProvjeri /tmp/libro-server.log"
        alert.alertStyle = .critical
        alert.addButton(withTitle: "OK")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func checkServer() -> Bool {
        let url = URL(string: STATUS_URL)!
        var serverUp = false
        let semaphore = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, response, _ in
            if let r = response as? HTTPURLResponse, r.statusCode == 200 {
                serverUp = true
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 3)
        return serverUp
    }

    // MARK: - Window

    func buildWindow() {
        let frame = NSRect(x: 80, y: 80, width: 1600, height: 1000)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "libro"
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.setFrameAutosaveName("LibroMainWindow")

        let config = WKWebViewConfiguration()
        let prefs = WKPreferences()
        prefs.javaScriptCanOpenWindowsAutomatically = true
        config.preferences = prefs
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false

        window.contentView = webView
        loadDashboard()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func loadDashboard() {
        if let url = URL(string: DASHBOARD_URL) {
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - Menu (Quit, Reload, Devtools)

    func buildMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About libro", action: #selector(showAbout), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Hide libro", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit libro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu (cut/copy/paste)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        // View menu
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(NSMenuItem(title: "Reload", action: #selector(reloadDashboard), keyEquivalent: "r"))
        viewMenu.addItem(NSMenuItem(title: "Force Reload", action: #selector(hardReload), keyEquivalent: "R"))
        viewMenu.addItem(NSMenuItem.separator())
        let fullscreenItem = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreenItem.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullscreenItem)
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        NSApp.mainMenu = mainMenu
    }

    @objc func showAbout() {
        let alert = NSAlert()
        alert.messageText = "libro"
        alert.informativeText = "Osobno računovodstvo.\n\nDashboard: \(DASHBOARD_URL)\n\nNative WKWebView wrapper."
        alert.runModal()
    }

    @objc func reloadDashboard() {
        webView.reload()
    }

    @objc func hardReload() {
        webView.reloadFromOrigin()
    }

    // MARK: - WebKit delegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // Mozda server je restartao — pokušaj reload za 2s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.loadDashboard()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.loadDashboard()
        }
    }

    // Allow new-window requests to open in same view (file downloads, etc.)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            // Otvori external URLs (npr. https links) u defaultnom browseru
            if url.scheme == "http" && url.host == "localhost" {
                webView.load(navigationAction.request)
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    // MARK: - File picker (input type=file)
    // Bez ovog handlera, WKWebView IGNORIRA <input type="file"> klik. Native NSOpenPanel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.canCreateDirectories = false
        panel.title = "Odaberi fajl"

        panel.begin { response in
            if response == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    // MARK: - Navigation policy (mailto: i druge sheme)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // mailto:, tel:, file: itd. → otvori u defaultnom system handleru (Mail.app)
        if let scheme = url.scheme, scheme != "http" && scheme != "https" && scheme != "about" && scheme != "blob" && scheme != "data" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        // External http(s) klik linka → defaultni browser
        if let scheme = url.scheme, (scheme == "http" || scheme == "https"),
           url.host != "localhost", url.host != "127.0.0.1",
           navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: - JS dialogs (alert/confirm/prompt) — bez ovog su no-op u WKWebView
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "libro"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "libro"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Odustani")
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "libro"
        alert.informativeText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Odustani")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
