import UIKit
import WebKit
import Network
import AVFoundation
import PhotosUI
import AuthenticationServices
import Security

class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let sharedProcessPool = WKProcessPool()
    private var webView: WKWebView!
    private var refreshControl: UIRefreshControl?
    private var loadingIndicator: UIActivityIndicatorView!
    private var loadingLabel: UILabel!
    private var errorContainerView: UIView?
    private var localServer: LocalStaticServer?
    private var currentImagePickTarget: String = "avatar"
    private var webAuthSession: ASWebAuthenticationSession?
    
    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }
    
    override var canBecomeFirstResponder: Bool {
        return true
    }
    
    var currentAppLang: String {
        if let envLang = ProcessInfo.processInfo.environment["MIRUO_LANG"], !envLang.isEmpty {
            return envLang
        }
        if let saved = UserDefaults.standard.string(forKey: "miruo_lang"), !saved.isEmpty {
            return saved
        }
        let preferred = Locale.preferredLanguages.first ?? "tr"
        if preferred.hasPrefix("en") { return "en" }
        if preferred.hasPrefix("de") { return "de" }
        return "tr"
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        let miruoDark = UIColor(red: 0.043, green: 0.035, blue: 0.063, alpha: 1.0)
        view.backgroundColor = miruoDark
        setupAudioSession()
        setupWebView()
        setupLoadingUI()
        loadPage()
    }
    
    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("AVAudioSession configuration error: \(error)")
        }
    }
    
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }
    
    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake {
            promptChangeServerUrl()
        }
    }
    
    private func setupWebView() {
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        
        let userContentController = WKUserContentController()
        userContentController.add(self, name: "openYouTube")
        userContentController.add(self, name: "openPlatform")
        userContentController.add(self, name: "pickImage")
        userContentController.add(self, name: "startAppleSignIn")
        userContentController.add(self, name: "startOAuthSignIn")
        userContentController.add(self, name: "copyToClipboard")
        userContentController.add(self, name: "clearPlatformSession")
        userContentController.add(self, name: "nativeShare")
        
        let authFixScriptSource = """
        (function() {
            try { delete window.PublicKeyCredential; } catch(e) {}
            try {
                Object.defineProperty(window, 'PublicKeyCredential', {
                    get: function() { return undefined; },
                    set: function() {},
                    configurable: true
                });
            } catch(e) {}
            if (window.navigator) {
                if (!window.navigator.credentials) {
                    try { window.navigator.credentials = {}; } catch(e) {}
                }
                try {
                    window.navigator.credentials.get = function() {
                        return Promise.reject(new DOMException("Passkey unsupported in embedded webview", "NotSupportedError"));
                    };
                    window.navigator.credentials.create = function() {
                        return Promise.reject(new DOMException("Passkey unsupported in embedded webview", "NotSupportedError"));
                    };
                } catch(e) {}
            }
        })();
        """
        let authFixScript = WKUserScript(source: authFixScriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(authFixScript)
        
        let config = WKWebViewConfiguration()
        config.processPool = ViewController.sharedProcessPool
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.userContentController = userContentController
        config.defaultWebpagePreferences = preferences
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        
        if #available(iOS 15.4, *) {
            config.preferences.isElementFullscreenEnabled = true
        }
        
        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1"
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = true
        let miruoDark = UIColor(red: 0.043, green: 0.035, blue: 0.063, alpha: 1.0)
        webView.backgroundColor = miruoDark
        webView.scrollView.backgroundColor = miruoDark
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        
        view.addSubview(webView)
    }
    
    private func setupLoadingUI() {
        loadingIndicator = UIActivityIndicatorView(style: .large)
        loadingIndicator.color = .systemPink
        loadingIndicator.translatesAutoresizingMaskIntoConstraints = false
        loadingIndicator.hidesWhenStopped = true
        loadingIndicator.isUserInteractionEnabled = false
        
        loadingLabel = UILabel()
        loadingLabel.text = currentAppLang == "en" ? "Connecting to Miruo..." : (currentAppLang == "de" ? "Verbindung zu Miruo wird hergestellt..." : "Miruo Bağlanıyor...")
        loadingLabel.textColor = .lightGray
        loadingLabel.font = UIFont.systemFont(ofSize: 13, weight: .medium)
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingLabel.isUserInteractionEnabled = false
        
        view.addSubview(loadingIndicator)
        view.addSubview(loadingLabel)
        
        NSLayoutConstraint.activate([
            loadingIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -20),
            loadingLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingLabel.topAnchor.constraint(equalTo: loadingIndicator.bottomAnchor, constant: 12)
        ])
    }
    
    @objc private func handleRefresh() {
        hideErrorUI()
        loadPage()
    }
    
    private func loadPage() {
        hideErrorUI()
        loadingIndicator.startAnimating()
        loadingLabel.isHidden = false
        
        // 1. ÖNCELİK: Dahili Güvenli Yerel HTTP Sunucusu (0ms Başlatma, 127.0.0.1, IP istemez, YouTube Error 153'ü engeller)
        if let bundleUrl = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public") {
            let publicDir = bundleUrl.deletingLastPathComponent()
            startLocalServerAndLoad(rootDir: publicDir, fallbackUrl: bundleUrl)
            return
        }
        
        if let bundleUrl = Bundle.main.url(forResource: "index", withExtension: "html") {
            let baseDir = bundleUrl.deletingLastPathComponent()
            startLocalServerAndLoad(rootDir: baseDir, fallbackUrl: bundleUrl)
            return
        }
        
        // 2. İsteğe Bağlı: Yalnızca özel geliştirici adresi girildiyse
        if let customUrl = UserDefaults.standard.string(forKey: "miruo_url"),
           let url = URL(string: customUrl), !customUrl.isEmpty, customUrl.hasPrefix("http") {
            let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
            webView.load(request)
            return
        }
        
        #if targetEnvironment(simulator)
        if let url = URL(string: "http://localhost:3000") {
            webView.load(URLRequest(url: url))
            return
        }
        #endif
        
        let missingFilesMsg = currentAppLang == "en" ? "App interface files could not be found." : (currentAppLang == "de" ? "App-Oberflächendateien konnten nicht gefunden werden." : "Uygulama arayüz dosyaları bulunamadı.")
        showErrorUI(message: missingFilesMsg)
    }

    func handleDeepLink(_ url: URL) {
        if url.scheme == "miruo" && (url.host == "auth" || url.absoluteString.contains("callback") || url.absoluteString.contains("access_token") || url.absoluteString.contains("code")) {
            sendOAuthResponse(["success": true, "url": url.absoluteString])
            return
        }
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            var roomId = components.queryItems?.first(where: { $0.name == "room" || $0.name == "id" })?.value ?? ""
            if roomId.isEmpty && url.path.contains("/oda/") {
                roomId = url.path.components(separatedBy: "/oda/").last?.components(separatedBy: "/").first ?? ""
            }
            if !roomId.isEmpty {
                let js = "if (typeof loadRoomFromDeepLink === 'function') { loadRoomFromDeepLink('\(roomId)'); } else { window.location.href = '/?room=\(roomId)'; }"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
    
    private func startLocalServerAndLoad(rootDir: URL, fallbackUrl: URL) {
        let testRoom = ProcessInfo.processInfo.environment["MIRUO_ROOM"]
        let testModal = ProcessInfo.processInfo.environment["MIRUO_MODAL"]
        let testProfile = ProcessInfo.processInfo.environment["MIRUO_PROFILE"]
        let testAuth = ProcessInfo.processInfo.environment["MIRUO_AUTH"]
        let testChat = ProcessInfo.processInfo.environment["MIRUO_CHAT"]
        var queryParts: [String] = []
        if let room = testRoom {
            queryParts.append("room=\(room)&cam=1")
        }
        if let modal = testModal {
            queryParts.append("modal=\(modal)")
        }
        if let profile = testProfile {
            queryParts.append("profile=\(profile)")
        }
        if let auth = testAuth {
            queryParts.append("auth=\(auth)")
        }
        if let chat = testChat {
            queryParts.append("chat=\(chat)")
        }
        let testView = ProcessInfo.processInfo.environment["MIRUO_VIEW"]
        if let view = testView {
            queryParts.append("view=\(view)")
        }
        let testLang = ProcessInfo.processInfo.environment["MIRUO_LANG"]
        if let lang = testLang {
            queryParts.append("lang=\(lang)")
        }
        let testAffinity = ProcessInfo.processInfo.environment["MIRUO_AFFINITY"]
        if let affinity = testAffinity {
            queryParts.append("affinity=\(affinity)")
        }
        let testPublicUser = ProcessInfo.processInfo.environment["MIRUO_PUBLIC_USER"]
        if let publicUser = testPublicUser {
            queryParts.append("public_user=\(publicUser)")
        }
        let query = !queryParts.isEmpty ? "?" + queryParts.joined(separator: "&") : ""
        if let server = localServer, server.isRunning {
            let url = URL(string: "http://127.0.0.1:\(server.port)/index.html\(query)")!
            webView.load(URLRequest(url: url))
            return
        }
        
        let server = LocalStaticServer(rootURL: rootDir, port: 8089)
        self.localServer = server
        server.start { [weak self] success in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if success, let url = URL(string: "http://127.0.0.1:\(server.port)/index.html\(query)") {
                    self.webView.load(URLRequest(url: url))
                } else {
                    // Güvenli yerel dosya yedeği
                    self.webView.loadFileURL(fallbackUrl, allowingReadAccessTo: rootDir)
                }
            }
        }
    }
    
    private func showErrorUI(message: String) {
        loadingIndicator.stopAnimating()
        loadingLabel.isHidden = true
        refreshControl?.endRefreshing()
        
        if errorContainerView != nil { return }
        
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.backgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.14, alpha: 0.98)
        container.layer.cornerRadius = 24
        container.layer.borderWidth = 1
        container.layer.borderColor = UIColor(white: 1.0, alpha: 0.15).cgColor
        container.clipsToBounds = true
        
        let stack = UIStackView()
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        
        let iconLabel = UILabel()
        iconLabel.text = "MIRUO"
        iconLabel.textColor = UIColor.systemPink
        iconLabel.font = UIFont.systemFont(ofSize: 22, weight: .black)
        
        let titleLabel = UILabel()
        titleLabel.text = currentAppLang == "en" ? "Reloading Miruo" : (currentAppLang == "de" ? "Miruo wird neu geladen" : "Miruo Yeniden Yükleniyor")
        titleLabel.textColor = .white
        titleLabel.font = UIFont.systemFont(ofSize: 18, weight: .bold)
        
        let descLabel = UILabel()
        descLabel.text = currentAppLang == "en" ? "There was a delay while loading the interface. Tap reload to start immediately." : (currentAppLang == "de" ? "Beim Laden der Benutzeroberfläche ist eine Verzögerung aufgetreten. Tippen Sie auf Neu laden, um sofort zu starten." : "Arayüz yüklenirken bir gecikme oluştu. Yenile butonuna basarak anında başlatabilirsiniz.")
        descLabel.textColor = UIColor(white: 0.75, alpha: 1.0)
        descLabel.font = UIFont.systemFont(ofSize: 12, weight: .regular)
        descLabel.textAlignment = .center
        descLabel.numberOfLines = 0
        
        let retryBtn = UIButton(type: .system)
        retryBtn.setTitle(currentAppLang == "en" ? "Try Again" : (currentAppLang == "de" ? "Erneut versuchen" : "Tekrar Dene"), for: .normal)
        retryBtn.backgroundColor = .systemPink
        retryBtn.setTitleColor(.white, for: .normal)
        retryBtn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
        retryBtn.layer.cornerRadius = 14
        retryBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 24, bottom: 10, right: 24)
        retryBtn.addTarget(self, action: #selector(handleRefresh), for: .touchUpInside)
        
        stack.addArrangedSubview(iconLabel)
        stack.addArrangedSubview(titleLabel)
        stack.addArrangedSubview(descLabel)
        stack.addArrangedSubview(retryBtn)
        
        container.addSubview(stack)
        view.addSubview(container)
        
        NSLayoutConstraint.activate([
            container.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            container.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            container.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            container.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20)
        ])
        
        errorContainerView = container
    }
    
    private func hideErrorUI() {
        errorContainerView?.removeFromSuperview()
        errorContainerView = nil
    }
    
    @objc private func promptChangeServerUrl() {
        let current = UserDefaults.standard.string(forKey: "miruo_url") ?? "http://192.168.1.20:3000"
        let alertTitle = currentAppLang == "en" ? "Miruo Server Configuration" : (currentAppLang == "de" ? "Miruo Servereinstellung" : "Miruo Sunucu Ayarı")
        let alertMsg = currentAppLang == "en" ? "Enter your computer's IP address (Must be on the same Wi-Fi network):" : (currentAppLang == "de" ? "Geben Sie die IP-Adresse Ihres Computers ein (Muss im selben WLAN sein):" : "Bilgisayarınızın IP adresini girin (Aynı Wi-Fi ağında olmalıdır):")
        let alert = UIAlertController(
            title: alertTitle,
            message: alertMsg,
            preferredStyle: .alert
        )
        
        alert.addTextField { tf in
            tf.placeholder = "http://192.168.1.20:3000"
            tf.text = current
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.clearButtonMode = .whileEditing
        }
        
        let ipTitle = currentAppLang == "en" ? "Current IP (192.168.1.20)" : (currentAppLang == "de" ? "Aktuelle IP (192.168.1.20)" : "Güncel IP (192.168.1.20)")
        alert.addAction(UIAlertAction(title: ipTitle, style: .default) { [weak self] _ in
            UserDefaults.standard.set("http://192.168.1.20:3000", forKey: "miruo_url")
            self?.loadPage()
        })
        
        let localTitle = currentAppLang == "en" ? "Localhost (Simulator)" : (currentAppLang == "de" ? "Localhost (Simulator)" : "Localhost (Simülatör)")
        alert.addAction(UIAlertAction(title: localTitle, style: .default) { [weak self] _ in
            UserDefaults.standard.set("http://localhost:3000", forKey: "miruo_url")
            self?.loadPage()
        })
        
        let saveTitle = currentAppLang == "en" ? "Save and Connect" : (currentAppLang == "de" ? "Speichern & Verbinden" : "Kaydet ve Bağlan")
        alert.addAction(UIAlertAction(title: saveTitle, style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            UserDefaults.standard.set(text, forKey: "miruo_url")
            self?.loadPage()
        })
        
        let cancelTitle = currentAppLang == "en" ? "Cancel" : (currentAppLang == "de" ? "Abbrechen" : "Vazgeç")
        alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel))
        present(alert, animated: true)
    }
    
    // WKScriptMessageHandler: JS calls window.webkit.messageHandlers.openYouTube / openPlatform
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "openYouTube" {
            let dict = message.body as? [String: Any]
            let lang = dict?["lang"] as? String ?? currentAppLang
            let hasActiveVideo = dict?["hasActiveVideo"] as? Bool ?? false
            openInAppPlatformBrowser(provider: "youtube", initialUrl: "https://m.youtube.com/feed/trending", title: "YouTube", lang: lang, hasActiveVideo: hasActiveVideo)
        } else if message.name == "openPlatform" {
            if let dict = message.body as? [String: Any] {
                let provider = dict["provider"] as? String ?? "youtube"
                let url = dict["url"] as? String ?? "https://m.youtube.com/feed/trending"
                let title = dict["title"] as? String ?? (currentAppLang == "en" ? "Browser" : (currentAppLang == "de" ? "Browser" : "Tarayıcı"))
                let lang = dict["lang"] as? String ?? currentAppLang
                let isConnectMode = (dict["action"] as? String == "connect") || (dict["mode"] as? String == "connect")
                let account = dict["account"] as? String ?? ""
                let hasActiveVideo = dict["hasActiveVideo"] as? Bool ?? false
                openInAppPlatformBrowser(provider: provider, initialUrl: url, title: title, lang: lang, isConnectMode: isConnectMode, connectedAccount: account, hasActiveVideo: hasActiveVideo)
            }
        } else if message.name == "pickImage" {
            var target = "avatar"
            if let dict = message.body as? [String: Any], let t = dict["target"] as? String {
                target = t
            } else if let s = message.body as? String {
                target = s
            }
            self.currentImagePickTarget = target
            openNativeImagePicker()
        } else if message.name == "startAppleSignIn" {
            startNativeAppleSignIn()
        } else if message.name == "startOAuthSignIn" {
            if let dict = message.body as? [String: Any],
               let urlString = dict["url"] as? String,
               let url = URL(string: urlString) {
                let scheme = (dict["callbackScheme"] as? String) ?? "miruo"
                startNativeOAuthSignIn(url: url, callbackScheme: scheme)
            }
        } else if message.name == "copyToClipboard" {
            var copyStr = ""
            if let str = message.body as? String {
                copyStr = str
            } else if let dict = message.body as? [String: Any], let str = dict["text"] as? String {
                copyStr = str
            }
            if !copyStr.isEmpty {
                UIPasteboard.general.string = copyStr
                let generator = UINotificationFeedbackGenerator()
                generator.notificationOccurred(.success)
            }
        } else if message.name == "clearPlatformSession" {
            var provider = ""
            if let dict = message.body as? [String: Any], let p = dict["provider"] as? String {
                provider = p
            } else if let s = message.body as? String {
                provider = s
            }
            if !provider.isEmpty {
                clearPlatformCookies(for: provider)
            }
        } else if message.name == "nativeShare" {
            if let dict = message.body as? [String: Any] {
                let text = dict["text"] as? String ?? ""
                var items: [Any] = []
                if !text.isEmpty { items.append(text) }
                if let urlStr = dict["url"] as? String, let url = URL(string: urlStr) {
                    items.append(url)
                }
                if !items.isEmpty {
                    let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
                    if let popover = activityVC.popoverPresentationController {
                        popover.sourceView = self.view
                        popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 0, height: 0)
                        popover.permittedArrowDirections = []
                    }
                    self.present(activityVC, animated: true, completion: nil)
                }
            }
        }
    }

    private func clearPlatformCookies(for provider: String) {
        let domains: [String]
        switch provider.lowercased() {
        case "youtube":
            domains = ["youtube.com", "google.com", "googlevideo.com", "ytimg.com", "ggpht.com", "youtu.be"]
        case "netflix":
            domains = ["netflix.com", "nflxso.net", "nflxext.com", "nflximg.net", "nflxvideo.net"]
        case "prime":
            domains = ["primevideo.com", "amazon.com", "amazon.co.uk", "amazon.de", "amazon.com.tr", "media-amazon.com", "aiv-cdn.net"]
        case "disney":
            domains = ["disneyplus.com", "disney.com", "bamgrid.com", "dssott.com"]
        case "twitch":
            domains = ["twitch.tv", "jtvnw.net", "ttvnw.net"]
        case "kick":
            domains = ["kick.com"]
        default:
            domains = [provider.lowercased()]
        }

        // 1. Delete from HTTPCookieStorage.shared
        if let sharedCookies = HTTPCookieStorage.shared.cookies {
            for cookie in sharedCookies {
                let cDom = cookie.domain.lowercased()
                if domains.contains(where: { cDom.contains($0) }) {
                    HTTPCookieStorage.shared.deleteCookie(cookie)
                }
            }
        }

        // 2. Delete from WKWebsiteDataStore.default().httpCookieStore
        let dataStore = WKWebsiteDataStore.default()
        dataStore.httpCookieStore.getAllCookies { cookies in
            for cookie in cookies {
                let cDom = cookie.domain.lowercased()
                if domains.contains(where: { cDom.contains($0) }) {
                    dataStore.httpCookieStore.delete(cookie, completionHandler: nil)
                }
            }
        }

        // 3. Remove WKWebsiteDataStore records (localStorage, indexedDB, cache, sessionStorage, cookies) for matching domains
        let allTypes = WKWebsiteDataStore.allWebsiteDataTypes()
        dataStore.fetchDataRecords(ofTypes: allTypes) { records in
            let matchingRecords = records.filter { record in
                let name = record.displayName.lowercased()
                return domains.contains(where: { name.contains($0) })
            }
            if !matchingRecords.isEmpty {
                dataStore.removeData(ofTypes: allTypes, for: matchingRecords) {
                    print("[Miruo] Cleared platform session data for \(provider)")
                }
            }
        }
    }
    
    private func startNativeOAuthSignIn(url: URL, callbackScheme: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.webAuthSession?.cancel()
            
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                guard let self = self else { return }
                self.webAuthSession = nil
                
                if let error = error {
                    let nsErr = error as NSError
                    let isCanceled = (nsErr.domain == ASWebAuthenticationSessionError.errorDomain && nsErr.code == ASWebAuthenticationSessionError.canceledLogin.rawValue) || nsErr.code == 1
                    let payload: [String: Any] = [
                        "success": false,
                        "canceled": isCanceled,
                        "error": isCanceled ? "canceled" : error.localizedDescription
                    ]
                    self.sendOAuthResponse(payload)
                    return
                }
                
                if let callbackURL = callbackURL {
                    let payload: [String: Any] = [
                        "success": true,
                        "url": callbackURL.absoluteString
                    ]
                    self.sendOAuthResponse(payload)
                }
            }
            
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.webAuthSession = session
            session.start()
        }
    }
    
    func sendOAuthResponse(_ payload: [String: Any]) {
        if let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            let js = "if (typeof window.handleNativeOAuthResponse === 'function') { window.handleNativeOAuthResponse(\(jsonString)); }"
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
    
    private func startNativeAppleSignIn() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let appleIDProvider = ASAuthorizationAppleIDProvider()
            let request = appleIDProvider.createRequest()
            request.requestedScopes = [.fullName, .email]
            
            let authorizationController = ASAuthorizationController(authorizationRequests: [request])
            authorizationController.delegate = self
            authorizationController.presentationContextProvider = self
            authorizationController.performRequests()
        }
    }
    
    func handleAppBackground() {
        let js = "if (typeof handleNativeAppBackgroundState === 'function') { handleNativeAppBackgroundState(true); }"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func handleAppForeground() {
        let js = "if (typeof handleNativeAppBackgroundState === 'function') { handleNativeAppBackgroundState(false); }"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func openNativeImagePicker() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            var topController: UIViewController = self
            while let presented = topController.presentedViewController, !presented.isBeingDismissed {
                topController = presented
            }
            
            if #available(iOS 14, *) {
                var config = PHPickerConfiguration()
                if self.currentImagePickTarget == "stage_media" || self.currentImagePickTarget == "gallery" {
                    config.filter = .any(of: [.images, .videos])
                } else {
                    config.filter = .images
                }
                config.selectionLimit = 1
                let picker = PHPickerViewController(configuration: config)
                picker.delegate = self
                picker.modalPresentationStyle = .pageSheet
                topController.present(picker, animated: true)
            } else {
                let picker = UIImagePickerController()
                if self.currentImagePickTarget == "stage_media" || self.currentImagePickTarget == "gallery" {
                    picker.mediaTypes = ["public.image", "public.movie"]
                } else {
                    picker.sourceType = .photoLibrary
                }
                picker.delegate = self
                topController.present(picker, animated: true)
            }
        }
    }
    
    private func openInAppPlatformBrowser(provider: String, initialUrl: String, title: String, lang: String? = nil, isConnectMode: Bool = false, connectedAccount: String = "", hasActiveVideo: Bool = false) {
        let browserVC = PlatformBrowserViewController()
        browserVC.provider = provider
        browserVC.initialUrl = initialUrl
        browserVC.browserTitle = title
        browserVC.currentLang = lang ?? currentAppLang
        browserVC.isConnectMode = isConnectMode
        browserVC.connectedAccount = connectedAccount
        browserVC.hasActiveVideo = hasActiveVideo
        browserVC.onAccountConnected = { [weak self] prov, acc in
            let escapedProv = prov.replacingOccurrences(of: "'", with: "\\'")
            let escapedAcc = acc.replacingOccurrences(of: "'", with: "\\'")
            let js = "window.MiruoBridge && window.MiruoBridge.onAccountConnected && window.MiruoBridge.onAccountConnected('\(escapedProv)', '\(escapedAcc)');"
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
        browserVC.onOpenProviderPicker = { [weak self] in
            if isConnectMode { return }
            let js = "if (typeof switchToProviderPicker === 'function') { switchToProviderPicker(); } else if (typeof openVideoChooser === 'function') { openVideoChooser(); }"
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
        browserVC.onVideoSelected = { [weak self] videoIdOrUrl, action in
            let escapedId = videoIdOrUrl.replacingOccurrences(of: "'", with: "\\'")
            let escapedAcc = connectedAccount.replacingOccurrences(of: "'", with: "\\'")
            if action == "queue" {
                let js = "window.MiruoBridge && window.MiruoBridge.addToQueue && window.MiruoBridge.addToQueue('\(escapedId)');"
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            } else {
                let js = "window.MiruoBridge && window.MiruoBridge.loadVideo('\(escapedId)', undefined, '\(provider)', '\(escapedAcc)');"
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        let nav = UINavigationController(rootViewController: browserVC)
        nav.modalPresentationStyle = .pageSheet
        if #available(iOS 15.0, *) {
            if let sheet = nav.sheetPresentationController {
                sheet.detents = [.medium(), .large()]
                sheet.prefersGrabberVisible = true
            }
        }
        present(nav, animated: true)
    }
    
    // WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingIndicator.stopAnimating()
        loadingLabel.isHidden = true
        refreshControl?.endRefreshing()
        hideErrorUI()

        if let autoRoom = ProcessInfo.processInfo.environment["AUTO_ROOM"] {
            let js = "setTimeout(() => { if (typeof loadRoomFromDeepLink === 'function') { loadRoomFromDeepLink('\(autoRoom)'); } }, 400);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_CAM"] {
            let js = "setTimeout(() => { if (typeof toggleCam === 'function') { toggleCam(); } }, 800);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_PARTICIPANTS"] {
            let js = "setTimeout(() => { if (typeof openRoomParticipantsModal === 'function') { openRoomParticipantsModal(); } }, 1000);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_SHARE"] ?? ProcessInfo.processInfo.environment["OPEN_ACCESS"] {
            let js = "setTimeout(() => { if (typeof openRoomAccessModal === 'function') { openRoomAccessModal(); } else { document.getElementById('roomAccessBtn')?.click(); } }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_LOGIN"] {
            let js = "setTimeout(() => { if (typeof setAuthMode === 'function') { setAuthMode(false); document.getElementById('authModal')?.classList.remove('hidden'); } }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_FORGOT_PASSWORD"] {
            let js = "setTimeout(() => { document.getElementById('forgotPasswordBtn')?.click(); }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_VIDEO_CHOOSER"] {
            let js = "setTimeout(() => { if (typeof openVideoChooser === 'function') { openVideoChooser(); } else { document.getElementById('roomChangeVideoBottomBtn')?.click(); } }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_QUEUE"] {
            let js = "setTimeout(() => { document.getElementById('roomQueueBadgeBtn')?.click(); }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_PLATFORM_BROWSER"] {
            let js = "setTimeout(() => { if (typeof openRealYouTubeInterface === 'function') { openRealYouTubeInterface(); } else { document.getElementById('openNativeYtBrowserBtn')?.click(); } }, 1500);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let scrollVal = ProcessInfo.processInfo.environment["MIRUO_SCROLL"] {
            let js = "setTimeout(() => { const el = document.getElementById('profileEditModalScrollBody') || window; el.scrollTop = \(scrollVal); }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_LOBBY"] {
            let js = """
            setTimeout(() => {
                document.getElementById('authModal')?.classList.add('hidden');
                if (typeof unfreezeBackgroundAfterModal === 'function') unfreezeBackgroundAfterModal();
                if (typeof switchToExplore === 'function') switchToExplore();
            }, 500);
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["CLOSE_CHAT"] {
            let js = "setTimeout(() => { if (typeof setChatVisibility === 'function') { setChatVisibility(false); } else { document.getElementById('closeChatSidebarBtn')?.click(); } }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let autoJs = ProcessInfo.processInfo.environment["AUTO_JS"] {
            let js = "setTimeout(() => { \(autoJs) }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_SETTINGS"] {
            let js = """
            setTimeout(() => {
                document.getElementById('authModal')?.classList.add('hidden');
                if (typeof unfreezeBackgroundAfterModal === 'function') unfreezeBackgroundAfterModal();
                if (typeof openProfileEditModal === 'function') openProfileEditModal('settings');
            }, 500);
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_GOOGLE_LOGIN"] {
            let js = "setTimeout(() => { document.getElementById('googleLoginBtn')?.click(); }, 1500);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_FRIENDS"] {
            let js = """
            setTimeout(() => {
                document.getElementById('authModal')?.classList.add('hidden');
                if (typeof unfreezeBackgroundAfterModal === 'function') unfreezeBackgroundAfterModal();
                if (typeof switchToFriendsTab === 'function') switchToFriendsTab();
                else document.getElementById('navFriendsBtn')?.click();
            }, 600);
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_CREATE_ROOM"] {
            let js = """
            setTimeout(() => {
                document.getElementById('authModal')?.classList.add('hidden');
                if (typeof unfreezeBackgroundAfterModal === 'function') unfreezeBackgroundAfterModal();
                if (typeof openCreateRoomModal === 'function') openCreateRoomModal();
                else document.getElementById('navCreateRoomBtn')?.click();
            }, 600);
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_PROFILE"] {
            let js = """
            setTimeout(() => {
                document.getElementById('authModal')?.classList.add('hidden');
                if (typeof unfreezeBackgroundAfterModal === 'function') unfreezeBackgroundAfterModal();
                if (typeof switchToProfileTab === 'function') switchToProfileTab();
                else document.getElementById('mobileNavProfileBtn')?.click();
            }, 600);
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
    
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showErrorUI(message: error.localizedDescription)
    }
    
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if let bundleUrl = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public") {
            let publicDir = bundleUrl.deletingLastPathComponent()
            webView.loadFileURL(bundleUrl, allowingReadAccessTo: publicDir)
            return
        }
        if let bundleUrl = Bundle.main.url(forResource: "index", withExtension: "html") {
            let baseDir = bundleUrl.deletingLastPathComponent()
            webView.loadFileURL(bundleUrl, allowingReadAccessTo: baseDir)
            return
        }
        showErrorUI(message: error.localizedDescription)
    }
    
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if let scheme = url.scheme?.lowercased(), scheme != "http" && scheme != "https" && scheme != "about" && scheme != "file" {
            if scheme == "sms" || scheme == "mailto" || scheme == "whatsapp" {
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
    
    // WKUIDelegate: WebRTC Camera & Microphone capture authorization (iOS 15+)
    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }
    
    // WKUIDelegate: Native JavaScript Alert & Confirm Handlers
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "Miruo", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
    
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Miruo", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "İptal", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Evet", style: .destructive) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}

// Full-Featured In-App Browser for YouTube, Netflix, Prime, Disney+, Twitch, Web, etc.
class PlatformBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UISearchBarDelegate {
    var provider: String = "youtube"
    var initialUrl: String = "https://m.youtube.com/feed/trending"
    var browserTitle: String = "YouTube"
    var currentLang: String = "tr"
    var isConnectMode: Bool = false
    var connectedAccount: String = ""
    var hasActiveVideo: Bool = false
    var onAccountConnected: ((String, String) -> Void)?
    var onOpenProviderPicker: (() -> Void)?
    var onVideoSelected: ((String, String) -> Void)?
    
    private var webView: WKWebView!
    private var searchBar: UISearchBar!
    private var progressView: UIProgressView!
    private var progressObservation: NSKeyValueObservation?
    private var syncBtn: UIButton?
    private var lastCapturedStreamUrl: String? = nil
    private var lastCapturedStreamTitle: String? = nil
    
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 1.0)
        edgesForExtendedLayout = []
        extendedLayoutIncludesOpaqueBars = true
        
        setupNavigationBar()
        setupWebView()
        setupBottomBar()
        loadInitialPage()
    }
    
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        progressObservation?.invalidate()
    }
    
    private func setupNavigationBar() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(red: 0.09, green: 0.10, blue: 0.15, alpha: 1.0)
        appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        navigationController?.navigationBar.standardAppearance = appearance
        navigationController?.navigationBar.scrollEdgeAppearance = appearance
        navigationController?.navigationBar.compactAppearance = appearance
        navigationController?.navigationBar.isTranslucent = false
        navigationController?.navigationBar.tintColor = .white
        
        let platformPickItem = UIBarButtonItem(title: "← Platform", style: .plain, target: self, action: #selector(openPlatformPickerTapped))
        platformPickItem.setTitleTextAttributes([.font: UIFont.systemFont(ofSize: 13, weight: .bold), .foregroundColor: UIColor.systemPink], for: .normal)
        
        let backItem = UIBarButtonItem(title: "‹", style: .plain, target: self, action: #selector(backTapped))
        backItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 22)], for: .normal)
        
        let forwardItem = UIBarButtonItem(title: "›", style: .plain, target: self, action: #selector(forwardTapped))
        forwardItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 22)], for: .normal)
        
        navigationItem.leftBarButtonItems = isConnectMode ? [backItem, forwardItem] : [platformPickItem, backItem, forwardItem]
        
        let closeItem = UIBarButtonItem(title: "✕", style: .done, target: self, action: #selector(closeTapped))
        closeItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 18), .foregroundColor: UIColor.systemRed], for: .normal)
        navigationItem.rightBarButtonItem = closeItem
        
        searchBar = UISearchBar()
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal
        searchBar.autocapitalizationType = .none
        searchBar.autocorrectionType = .no
        
        if provider == "youtube" {
            searchBar.placeholder = currentLang == "en" ? "Search YouTube..." : (currentLang == "de" ? "Auf YouTube suchen..." : "YouTube'da ara...")
        } else if provider == "twitch" {
            searchBar.placeholder = currentLang == "en" ? "Search Twitch..." : (currentLang == "de" ? "Auf Twitch suchen..." : "Twitch'te yayın ara...")
        } else if provider == "kick" {
            searchBar.placeholder = currentLang == "en" ? "Search Kick..." : (currentLang == "de" ? "Auf Kick suchen..." : "Kick'te yayın ara...")
        } else if provider == "netflix" {
            searchBar.placeholder = currentLang == "en" ? "Search Netflix..." : (currentLang == "de" ? "Auf Netflix suchen..." : "Netflix'te ara...")
        } else if provider == "prime" {
            searchBar.placeholder = currentLang == "en" ? "Search Prime Video..." : (currentLang == "de" ? "Auf Prime Video suchen..." : "Prime Video'da ara...")
        } else if provider == "disney" {
            searchBar.placeholder = currentLang == "en" ? "Search Disney+..." : (currentLang == "de" ? "Auf Disney+ suchen..." : "Disney+'ta ara...")
        } else {
            searchBar.placeholder = currentLang == "en" ? "Search or enter link..." : (currentLang == "de" ? "Suchen oder Link eingeben..." : "Ara veya link yaz...")
        }
        
        if let tf = searchBar.value(forKey: "searchField") as? UITextField {
            tf.backgroundColor = UIColor(white: 0.18, alpha: 1.0)
            tf.textColor = .white
            tf.tintColor = .systemRed
            tf.font = UIFont.systemFont(ofSize: 12)
        }
        navigationItem.titleView = searchBar
        
        // Progress bar at top
        progressView = UIProgressView(progressViewStyle: .bar)
        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progressTintColor = .systemRed
        progressView.trackTintColor = .clear
        view.addSubview(progressView)
        
        NSLayoutConstraint.activate([
            progressView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2)
        ])
    }
    
    private func setupWebView() {
        let userContentController = WKUserContentController()
        userContentController.add(self, name: "videoIntercepted")
        userContentController.add(self, name: "streamDetected")
        
        let streamScriptSource = """
        (function() {
            function postMedia(src, title) {
                if (!src || typeof src !== 'string' || src.length < 8) return;
                if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) return;
                try {
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.streamDetected) {
                        window.webkit.messageHandlers.streamDetected.postMessage({
                            url: src,
                            title: title || document.title || 'Video'
                        });
                    }
                } catch(e) {}
            }

            function scanVideos() {
                var vids = document.querySelectorAll('video');
                for (var i = 0; i < vids.length; i++) {
                    var v = vids[i];
                    var s = v.currentSrc || v.src;
                    if (s) postMedia(s, document.title);
                    var sources = v.querySelectorAll('source');
                    for (var j = 0; j < sources.length; j++) {
                        var ss = sources[j].src;
                        if (ss) postMedia(ss, document.title);
                    }
                    if (!v.__miruoBound) {
                        v.__miruoBound = true;
                        ['play', 'playing', 'loadeddata', 'loadedmetadata', 'canplay'].forEach(function(evt) {
                            v.addEventListener(evt, function() {
                                var cur = v.currentSrc || v.src;
                                if (cur) postMedia(cur, document.title);
                            }, true);
                        });
                    }
                }
            }

            try {
                var _origFetch = window.fetch;
                if (_origFetch) {
                    window.fetch = function() {
                        var args = arguments;
                        var u = (args[0] instanceof Request) ? args[0].url : args[0];
                        if (typeof u === 'string' && (u.indexOf('.m3u8') !== -1 || u.indexOf('.mp4') !== -1 || u.indexOf('/hls/') !== -1 || u.indexOf('/stream/') !== -1)) {
                            postMedia(u, document.title);
                        }
                        return _origFetch.apply(this, args);
                    };
                }
            } catch(e) {}

            try {
                var _origXHR = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    if (typeof url === 'string' && (url.indexOf('.m3u8') !== -1 || url.indexOf('.mp4') !== -1 || url.indexOf('/hls/') !== -1 || url.indexOf('/stream/') !== -1)) {
                        postMedia(url, document.title);
                    }
                    return _origXHR.apply(this, arguments);
                };
            } catch(e) {}

            setInterval(scanVideos, 1500);
            document.addEventListener('DOMContentLoaded', scanVideos);
        })();
        """
        let streamScript = WKUserScript(source: streamScriptSource, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
        userContentController.addUserScript(streamScript)
        
        let scriptSource = """
        (function() {
            var style = document.createElement('style');
            style.innerHTML = `
                ytm-promoted-sparkles-web-renderer,
                .ad-container,
                .ytm-promoted-item,
                ytm-open-app-banner-renderer,
                .open-app-banner,
                .upsell-dialog,
                .ytm-open-app-tool-renderer,
                .smartbanner,
                .open-in-app,
                ytm-pivot-bar-renderer {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);

            function isChannelLink(url) {
                if (!url) return false;
                return url.includes('/@') || url.includes('/channel/') || url.includes('/c/') || url.includes('/user/');
            }

            function notifyVideo(id) {
                if (id && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.videoIntercepted) {
                    window.webkit.messageHandlers.videoIntercepted.postMessage(id);
                }
            }

            function extractId(url) {
                if (!url || isChannelLink(url)) return null;
                var m = url.match(/[?&]v=([^&#]+)/);
                if (m) return m[1];
                m = url.match(/\\/shorts\\/([^?&#/]+)/);
                if (m) return m[1];
                m = url.match(/youtu\\.be\\/([^?&#/]+)/);
                if (m) return m[1];
                return null;
            }

            document.addEventListener('click', function(e) {
                var el = e.target.closest('a');
                if (el && el.href) {
                    if (isChannelLink(el.href)) return;
                    var vid = extractId(el.href);
                    if (vid) {
                        e.preventDefault();
                        e.stopPropagation();
                        notifyVideo(vid);
                    }
                }
            }, true);
        })();
        """
        let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
        userContentController.addUserScript(userScript)
        
        // Google & OAuth WebAuthn / Passkey / Bluetooth Bypass for Embedded WKWebView
        // Disables broken WebAuthn cross-device passkey flow in WKWebView so Google/platforms immediately prompt for standard Password / SMS / App confirmation without "Bluetooth'un açık..." error.
        let authFixScriptSource = """
        (function() {
            try { delete window.PublicKeyCredential; } catch(e) {}
            try {
                Object.defineProperty(window, 'PublicKeyCredential', {
                    get: function() { return undefined; },
                    set: function() {},
                    configurable: true
                });
            } catch(e) {}

            if (window.navigator) {
                if (!window.navigator.credentials) {
                    try { window.navigator.credentials = {}; } catch(e) {}
                }
                try {
                    window.navigator.credentials.get = function() {
                        return Promise.reject(new DOMException("Passkey unsupported in embedded webview", "NotSupportedError"));
                    };
                    window.navigator.credentials.create = function() {
                        return Promise.reject(new DOMException("Passkey unsupported in embedded webview", "NotSupportedError"));
                    };
                } catch(e) {}
            }

            // Auto-click "Başka bir yöntem dene" (Try another way) if Google shows the Bluetooth/passkey error screen
            function checkGoogleTryAnotherWay() {
                try {
                    if (location.hostname.indexOf('google.') !== -1) {
                        var text = document.body ? (document.body.innerText || '') : '';
                        if (text.indexOf('Bluetooth') !== -1 || text.indexOf('ters gitti') !== -1 || text.indexOf('Something went wrong') !== -1) {
                            var elms = document.querySelectorAll('button, a, span[role="button"], div[role="button"]');
                            for (var i = 0; i < elms.length; i++) {
                                var label = (elms[i].innerText || '').toLowerCase().trim();
                                if (label.indexOf('başka bir yöntem') !== -1 || label.indexOf('try another') !== -1 || label.indexOf('andere option') !== -1) {
                                    elms[i].click();
                                    break;
                                }
                            }
                        }
                    }
                } catch(e) {}
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', checkGoogleTryAnotherWay);
            } else {
                setTimeout(checkGoogleTryAnotherWay, 200);
            }
            var count = 0;
            var timer = setInterval(function() {
                count++;
                checkGoogleTryAnotherWay();
                if (count > 15) clearInterval(timer);
            }, 350);
        })();
        """
        let authFixScript = WKUserScript(source: authFixScriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(authFixScript)
        
        let config = WKWebViewConfiguration()
        config.processPool = ViewController.sharedProcessPool
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.userContentController = userContentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        
        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1"
        webView.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 1.0)
        webView.scrollView.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.12, alpha: 1.0)
        view.addSubview(webView)
        
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
            let progress = Float(wv.estimatedProgress)
            self?.progressView.progress = progress
            self?.progressView.isHidden = progress >= 1.0
        }
    }
    
    private func setupBottomBar() {
        if isConnectMode {
            // In connect mode: full-screen webview without bottom bar (no manual return button!)
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: progressView.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
            ])
            return
        }
        
        let bottomBar = UIView()
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.backgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.14, alpha: 0.98)
        bottomBar.layer.borderWidth = 0.5
        bottomBar.layer.borderColor = UIColor(white: 0.2, alpha: 1.0).cgColor
        view.addSubview(bottomBar)
        
        let syncBtn = UIButton(type: .system)
        syncBtn.translatesAutoresizingMaskIntoConstraints = false
        let btnTitle = currentLang == "en" ? "Stream Video to Room" : (currentLang == "de" ? "Video in den Raum übertragen" : "Bu Videoyu Odaya Aktar ve İzle")
        syncBtn.setTitle(btnTitle, for: .normal)
        syncBtn.backgroundColor = UIColor(red: 0.88, green: 0.12, blue: 0.28, alpha: 1.0)
        syncBtn.setTitleColor(.white, for: .normal)
        syncBtn.titleLabel?.font = UIFont.boldSystemFont(ofSize: 13)
        syncBtn.layer.cornerRadius = 14
        syncBtn.addTarget(self, action: #selector(syncCurrentContentTapped), for: .touchUpInside)
        bottomBar.addSubview(syncBtn)
        self.syncBtn = syncBtn
        
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: progressView.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomBar.topAnchor),
            
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            bottomBar.heightAnchor.constraint(equalToConstant: 52),
            
            syncBtn.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 14),
            syncBtn.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -14),
            syncBtn.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 8),
            syncBtn.bottomAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: -8)
        ])
    }
    
    private func loadInitialPage() {
        if let url = URL(string: initialUrl) {
            webView.load(URLRequest(url: url))
        }
    }
    
    // UISearchBarDelegate
    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
        searchBar.resignFirstResponder()
        guard let text = searchBar.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        
        if text.hasPrefix("http://") || text.hasPrefix("https://") {
            if let u = URL(string: text) { webView.load(URLRequest(url: u)) }
        } else if text.contains(".") && !text.contains(" ") {
            if let u = URL(string: "https://" + text) { webView.load(URLRequest(url: u)) }
        } else {
            let encoded = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
            var targetStr = ""
            switch provider {
            case "youtube":
                targetStr = "https://m.youtube.com/results?search_query=\(encoded)"
            case "twitch":
                targetStr = "https://m.twitch.tv/search?term=\(encoded)"
            case "kick":
                targetStr = "https://kick.com/search?q=\(encoded)"
            case "netflix":
                targetStr = "https://www.netflix.com/search?q=\(encoded)"
            case "prime":
                targetStr = "https://www.primevideo.com/search/ref=atv_nb_sr?phrase=\(encoded)"
            case "disney":
                targetStr = "https://www.disneyplus.com/search?q=\(encoded)"
            default:
                targetStr = "https://www.google.com/search?q=\(encoded)"
            }
            if let u = URL(string: targetStr) {
                webView.load(URLRequest(url: u))
            }
        }
    }
    
    @objc private func openPlatformPickerTapped() {
        webView.evaluateJavaScript("try { var v = document.querySelectorAll('video, audio'); v.forEach(function(el){ el.pause(); el.src = ''; }); } catch(e) {}")
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        dismiss(animated: true) { [weak self] in
            self?.onOpenProviderPicker?()
        }
    }
    
    @objc private func backTapped() {
        if webView.canGoBack {
            webView.goBack()
        } else {
            if isConnectMode {
                webView.evaluateJavaScript("try { var v = document.querySelectorAll('video, audio'); v.forEach(function(el){ el.pause(); el.src = ''; }); } catch(e) {}")
                webView.load(URLRequest(url: URL(string: "about:blank")!))
                dismiss(animated: true, completion: nil)
            } else {
                openPlatformPickerTapped()
            }
        }
    }
    
    @objc private func forwardTapped() {
        if webView.canGoForward {
            webView.goForward()
        }
    }
    
    @objc private func reloadTapped() {
        webView.reload()
    }
    
    @objc private func closeTapped() {
        webView.evaluateJavaScript("try { var v = document.querySelectorAll('video, audio'); v.forEach(function(el){ el.pause(); el.src = ''; }); } catch(e) {}")
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        dismiss(animated: true)
    }
    
    private func handleSelectedVideo(_ videoId: String) {
        // Prevent background audio overlap: stop video element in browser immediately!
        self.webView.evaluateJavaScript("try { var v = document.querySelectorAll('video, audio'); v.forEach(function(el){ el.pause(); el.src = ''; }); } catch(e) {}")
        
        // If there is NO active video playing in the room yet, directly start playback without prompting!
        if !hasActiveVideo {
            self.webView.load(URLRequest(url: URL(string: "about:blank")!))
            self.dismiss(animated: true) { [weak self] in
                self?.onVideoSelected?(videoId, "play")
            }
            return
        }
        
        // Only if a video is ALREADY actively playing in the room (2nd video), offer Play Immediately or Add to Queue!
        let alert = UIAlertController(title: "Video Seçildi", message: "Ne yapmak istersiniz?", preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "Hemen Oynat", style: .default, handler: { [weak self] _ in
            self?.webView.load(URLRequest(url: URL(string: "about:blank")!))
            self?.dismiss(animated: true) {
                self?.onVideoSelected?(videoId, "play")
            }
        }))
        alert.addAction(UIAlertAction(title: "Sıraya Ekle", style: .default, handler: { [weak self] _ in
            self?.onVideoSelected?(videoId, "queue")
            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)
            let toast = UIAlertController(title: "✓ Sıraya Eklendi", message: "Video sıraya eklendi. Odanızdaki video kesintisiz devam ediyor.", preferredStyle: .alert)
            self?.present(toast, animated: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                toast.dismiss(animated: true, completion: nil)
            }
        }))
        alert.addAction(UIAlertAction(title: "İptal", style: .cancel, handler: nil))
        
        if let popover = alert.popoverPresentationController {
            popover.sourceView = self.view
            popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        present(alert, animated: true)
    }
    
    @objc private func syncCurrentContentTapped() {
        guard let currentUrl = webView.url else { return }
        let currentUrlStr = currentUrl.absoluteString
        
        // 1. YouTube direct check
        if let ytId = extractYouTubeId(urlString: currentUrlStr) {
            handleSelectedVideo(ytId)
            return
        }

        // 2. Direct captured media stream (.m3u8 / .mp4 / video stream) from any frame
        if let captured = lastCapturedStreamUrl, !captured.isEmpty {
            handleSelectedVideo(captured)
            return
        }
        
        // 3. Extract media stream or player iframe URL from free movie/streaming sites
        let extractJs = """
        (function() {
            // A. Direct <video> tags
            var vids = document.querySelectorAll('video');
            for (var i = 0; i < vids.length; i++) {
                var v = vids[i];
                var s = v.currentSrc || v.src;
                if (s && s.indexOf('blob:') !== 0 && s.length > 8) {
                    return s;
                }
                var sources = v.querySelectorAll('source');
                for (var j = 0; j < sources.length; j++) {
                    var ss = sources[j].src;
                    if (ss && ss.indexOf('blob:') !== 0 && ss.length > 8) {
                        return ss;
                    }
                }
            }
            // B. Scan iframes for embedded players
            var iframes = document.querySelectorAll('iframe');
            for (var k = 0; k < iframes.length; k++) {
                var ifr = iframes[k];
                try {
                    var doc = ifr.contentDocument || ifr.contentWindow.document;
                    if (doc) {
                        var iv = doc.querySelector('video');
                        if (iv && (iv.currentSrc || iv.src)) {
                            var isrc = iv.currentSrc || iv.src;
                            if (isrc.indexOf('blob:') !== 0) return isrc;
                        }
                    }
                } catch(e) {}
                var src = ifr.src || '';
                if (src && (src.indexOf('.m3u8') !== -1 || src.indexOf('.mp4') !== -1 || src.indexOf('/embed') !== -1 || src.indexOf('/player') !== -1 || src.indexOf('vidmoly') !== -1 || src.indexOf('filemoon') !== -1 || src.indexOf('streamtape') !== -1 || src.indexOf('dood') !== -1 || src.indexOf('play') !== -1)) {
                    return src;
                }
            }
            // C. Resource timing entries
            if (window.performance && performance.getEntriesByType) {
                var entries = performance.getEntriesByType('resource');
                for (var r = entries.length - 1; r >= 0; r--) {
                    var rname = entries[r].name || '';
                    if (rname.indexOf('.m3u8') !== -1 || rname.indexOf('.mp4') !== -1 || rname.indexOf('/hls/') !== -1) {
                        return rname;
                    }
                }
            }
            return window.location.href;
        })()
        """
        
        webView.evaluateJavaScript(extractJs) { [weak self] res, _ in
            guard let self = self else { return }
            let finalUrl = (res as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let videoId = (finalUrl != nil && !finalUrl!.isEmpty) ? finalUrl! : currentUrlStr
            self.handleSelectedVideo(videoId)
        }
    }
    
    private var hasReportedAutoLogin = false

    private func checkAndHandleAutoLogin() {
        guard !isBeingDismissed, !hasReportedAutoLogin else { return }
        guard isConnectMode || connectedAccount.isEmpty else { return }
        guard let currentUrl = webView.url?.absoluteString else { return }
        let lower = currentUrl.lowercased()
        
        // 1. If still on signin, password, login, or service login page, do NOT connect yet!
        if lower.contains("servicelogin") || lower.contains("/signin") || lower.contains("identifier") || lower.contains("/v3/signin") || lower.contains("/login") || lower.contains("openid") || lower.contains("challenge") || lower.contains("auth-redirect") || lower.contains("/ap/") {
            return
        }
        
        // 2. Check cookies & URL to ensure genuine authenticated session
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, !self.isBeingDismissed, !self.hasReportedAutoLogin else { return }
            
            var isActuallyAuthenticated = false
            
            switch self.provider {
            case "youtube":
                let isYtDomain = lower.contains("youtube.com") && !lower.contains("accounts.google")
                let hasYtAuthCookie = cookies.contains { c in
                    (c.domain.contains("youtube.com") || c.domain.contains(".google.com")) && 
                    (c.name == "LOGIN_INFO" || c.name == "SID" || c.name == "SSID" || c.name == "SAPISID")
                }
                isActuallyAuthenticated = isYtDomain && hasYtAuthCookie
                
            case "netflix":
                let isNfDomain = lower.contains("netflix.com")
                let hasNfAuthCookie = cookies.contains { c in
                    c.domain.contains("netflix.com") && (c.name == "NetflixId" || c.name == "SecureNetflixId")
                }
                let isNfBrowse = lower.contains("/browse") || lower.contains("/profiles")
                isActuallyAuthenticated = isNfDomain && (hasNfAuthCookie || isNfBrowse)
                
            case "prime":
                let isPrimeDomain = lower.contains("primevideo.com") || lower.contains("amazon.")
                let notInAuth = !lower.contains("/ap/") && !lower.contains("auth-redirect") && !lower.contains("/signin")
                let hasPrimeAuthCookie = cookies.contains { c in
                    (c.domain.contains("primevideo.com") || c.domain.contains("amazon.")) && 
                    (c.name == "at-main" || c.name == "session-token" || c.name == "ubid-main" || c.name == "at-acbtr")
                }
                let isPrimeStore = lower.contains("/storefront") || lower.contains("/detail") || lower.contains("/region/") || lower.contains("/movie/") || lower.contains("/tv/")
                isActuallyAuthenticated = isPrimeDomain && notInAuth && (hasPrimeAuthCookie || isPrimeStore)
                
            case "disney":
                let isDisneyDomain = lower.contains("disneyplus.com")
                let hasDisneyAuthCookie = cookies.contains { c in
                    c.domain.contains("disneyplus.com") && (c.name == "disney_user_session" || c.name == "idp_token")
                }
                let isDisneyHome = lower.contains("/home") || lower.contains("/browse")
                isActuallyAuthenticated = isDisneyDomain && (hasDisneyAuthCookie || isDisneyHome)
                
            default:
                isActuallyAuthenticated = false
            }
            
            guard isActuallyAuthenticated else { return }
            self.hasReportedAutoLogin = true
            
            // Extract detected email/username via DOM
            self.webView.evaluateJavaScript("""
                (function() {
                    try {
                        var text = document.body ? document.body.innerText : '';
                        var m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
                        if (m) return m[0];
                    } catch(e) {}
                    return '';
                })()
            """) { [weak self] (result, _) in
                guard let self = self, !self.isBeingDismissed else { return }
                let detectedEmail = (result as? String) ?? ""
                let finalAcc = !detectedEmail.isEmpty ? detectedEmail : "\(self.provider.capitalized) Hesabı (Aktif)"
                self.connectedAccount = finalAcc
                
                if self.isConnectMode {
                    // Opened from Settings -> Auto-dismiss and notify Miruo
                    self.dismiss(animated: true) {
                        self.onAccountConnected?(self.provider, finalAcc)
                    }
                } else {
                    // Opened inside Room -> Notify Miruo without closing browser so user can pick their video
                    self.onAccountConnected?(self.provider, finalAcc)
                }
            }
        }
    }
    
    // WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "videoIntercepted", let videoId = message.body as? String, !videoId.isEmpty {
            handleSelectedVideo(videoId)
        } else if message.name == "streamDetected" {
            var detectedUrl = ""
            var detectedTitle = ""
            if let dict = message.body as? [String: Any] {
                detectedUrl = dict["url"] as? String ?? ""
                detectedTitle = dict["title"] as? String ?? ""
            } else if let s = message.body as? String {
                detectedUrl = s
            }
            if !detectedUrl.isEmpty && detectedUrl.count > 8 {
                self.lastCapturedStreamUrl = detectedUrl
                if !detectedTitle.isEmpty {
                    self.lastCapturedStreamTitle = detectedTitle
                }
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    let readyTitle = self.currentLang == "en" ? "✓ Video Ready! Stream to Room" : (self.currentLang == "de" ? "✓ Video Bereit! Übertragen" : "✓ Video Hazır! Odaya Aktar")
                    self.syncBtn?.setTitle(readyTitle, for: .normal)
                    self.syncBtn?.backgroundColor = UIColor(red: 0.16, green: 0.65, blue: 0.27, alpha: 1.0)
                }
            }
        }
    }
    
    // Intercept navigation
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        
        if let scheme = url.scheme?.lowercased(), scheme != "http" && scheme != "https" && scheme != "about" {
            if scheme == "sms" || scheme == "mailto" || scheme == "whatsapp" {
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                }
                decisionHandler(.cancel)
                return
            }
            // Block external app switching (e.g. youtube://, netflix://) so it never kicks the user out of Miruo
            decisionHandler(.cancel)
            return
        }
        
        let urlStr = url.absoluteString
        if urlStr.contains("/@") || urlStr.contains("/channel/") || urlStr.contains("/c/") || urlStr.contains("/user/") {
            decisionHandler(.allow)
            return
        }
        
        if let videoId = extractYouTubeId(urlString: urlStr) {
            decisionHandler(.cancel)
            handleSelectedVideo(videoId)
            return
        }
        
        decisionHandler(.allow)
    }
    
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let current = webView.url?.absoluteString {
            if isConnectMode {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.checkAndHandleAutoLogin()
                }
            }

            if !searchBar.isFirstResponder {
                if current.contains("results?search_query=") {
                    // keep search text
                } else if current.contains("/@") || current.contains("/channel/") {
                    searchBar.text = webView.title
                }
            }
        }
    }
    
    private func extractYouTubeId(urlString: String) -> String? {
        if urlString.contains("/watch") {
            if let components = URLComponents(string: urlString),
               let queryItems = components.queryItems {
                return queryItems.first(where: { $0.name == "v" })?.value
            }
        } else if urlString.contains("youtu.be/") {
            let parts = urlString.components(separatedBy: "youtu.be/")
            if parts.count > 1 {
                return parts[1].components(separatedBy: "?").first
            }
        } else if urlString.contains("/shorts/") {
            let parts = urlString.components(separatedBy: "/shorts/")
            if parts.count > 1 {
                return parts[1].components(separatedBy: "?").first
            }
        }
        return nil
    }
    
    // MARK: - WKUIDelegate: Popups & JavaScript Alerts for Platforms & Google Login
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
    
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        let okTitle = currentLang == "en" ? "OK" : (currentLang == "de" ? "OK" : "Tamam")
        alert.addAction(UIAlertAction(title: okTitle, style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
}

typealias YouTubeBrowserViewController = PlatformBrowserViewController

// MARK: - Local Embedded HTTP Server for WKWebView (Eliminates Error 153 & Origin Null)
class LocalStaticServer {
    private var listener: NWListener?
    private let rootURL: URL
    private(set) var port: UInt16
    private(set) var isRunning: Bool = false
    
    init(rootURL: URL, port: UInt16 = 8089) {
        self.rootURL = rootURL
        self.port = port
    }
    
    func start(completion: @escaping (Bool) -> Void) {
        if isRunning {
            completion(true)
            return
        }
        startOnPort(port, attemptsRemaining: 5, completion: completion)
    }
    
    private func startOnPort(_ targetPort: UInt16, attemptsRemaining: Int, completion: @escaping (Bool) -> Void) {
        do {
            let nwPort = NWEndpoint.Port(rawValue: targetPort) ?? 8089
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let newListener = try NWListener(using: params, on: nwPort)
            
            newListener.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    self.isRunning = true
                    self.port = targetPort
                    completion(true)
                case .failed:
                    if attemptsRemaining > 0 {
                        self.startOnPort(targetPort + 1, attemptsRemaining: attemptsRemaining - 1, completion: completion)
                    } else {
                        completion(false)
                    }
                default:
                    break
                }
            }
            
            newListener.newConnectionHandler = { [weak self] connection in
                self?.handleConnection(connection)
            }
            
            self.listener = newListener
            newListener.start(queue: .global(qos: .userInitiated))
        } catch {
            if attemptsRemaining > 0 {
                startOnPort(targetPort + 1, attemptsRemaining: attemptsRemaining - 1, completion: completion)
            } else {
                completion(false)
            }
        }
    }
    
    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        receiveRequest(on: connection)
    }
    
    private func receiveRequest(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 262144) { [weak self] content, _, _, _ in
            guard let self = self, let content = content, let requestString = String(data: content, encoding: .utf8) else {
                connection.cancel()
                return
            }
            
            let firstLine = requestString.components(separatedBy: "\r\n").first ?? ""
            let parts = firstLine.components(separatedBy: " ")
            guard parts.count >= 2 else {
                self.sendResponse(connection: connection, statusCode: 400, contentType: "text/plain", data: Data("Bad Request".utf8))
                return
            }
            
            let method = parts[0].uppercased()
            var path = parts[1]
            if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
            
            if method == "OPTIONS" {
                self.sendResponse(connection: connection, statusCode: 204, contentType: "text/plain", data: Data())
                return
            }
            
            if path.hasPrefix("/api/auth/") {
                let bodyString: String
                if let range = requestString.range(of: "\r\n\r\n") {
                    bodyString = String(requestString[range.upperBound...])
                } else {
                    bodyString = "{}"
                }
                let (statusCode, responseDict) = MiruoPersistentAuthStore.shared.handleAuthEndpoint(path: path, method: method, bodyString: bodyString)
                let jsonData = (try? JSONSerialization.data(withJSONObject: responseDict, options: [])) ?? Data("{}".utf8)
                self.sendResponse(connection: connection, statusCode: statusCode, contentType: "application/json; charset=utf-8", data: jsonData)
                return
            }
            
            guard method == "GET" else {
                self.sendResponse(connection: connection, statusCode: 400, contentType: "text/plain", data: Data("Bad Request".utf8))
                return
            }
            
            if path == "/" || path.isEmpty { path = "/index.html" }
            let relativePath = path.hasPrefix("/") ? String(path.dropFirst()) : path
            let fileURL = self.rootURL.appendingPathComponent(relativePath)
            
            if let fileData = try? Data(contentsOf: fileURL) {
                let mimeType = self.mimeType(for: fileURL.pathExtension)
                self.sendResponse(connection: connection, statusCode: 200, contentType: mimeType, data: fileData)
            } else {
                self.sendResponse(connection: connection, statusCode: 404, contentType: "text/plain", data: Data("Not Found".utf8))
            }
        }
    }
    
    private func sendResponse(connection: NWConnection, statusCode: Int, contentType: String, data: Data) {
        let statusText: String
        switch statusCode {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 409: statusText = "Conflict"
        default: statusText = "Not Found"
        }
        var header = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(data.count)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
        header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        header += "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
        header += "Connection: close\r\n\r\n"
        
        var responseData = Data(header.utf8)
        responseData.append(data)
        
        connection.send(content: responseData, completion: .contentProcessed({ _ in
            connection.cancel()
        }))
    }
    
    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Persistent Keychain + Documents Auth Store (Single Registration Per Apple ID / Email)
final class MiruoPersistentAuthStore {
    static let shared = MiruoPersistentAuthStore()
    private let service = "com.miruo.app.appleauth"
    private let queue = DispatchQueue(label: "com.miruo.app.authstore")
    
    private var dbFileURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("miruo_users_db.json")
    }
    
    func saveKeychainString(_ value: String, account: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(addQuery as CFDictionary, nil)
    }
    
    func loadKeychainString(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, let str = String(data: data, encoding: .utf8) {
            return str
        }
        return nil
    }
    
    func deleteKeychainItem(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
    
    func decodeJwtPayload(_ jwt: String) -> [String: Any]? {
        let segments = jwt.components(separatedBy: ".")
        guard segments.count > 1 else { return nil }
        var base64 = segments[1]
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            return nil
        }
        return json
    }
    
    func loadUsers() -> [[String: Any]] {
        if let kcStr = loadKeychainString(account: "miruo_users_db_v1"),
           let data = kcStr.data(using: .utf8),
           let arr = try? JSONSerialization.jsonObject(with: data, options: []) as? [[String: Any]],
           !arr.isEmpty {
            return arr
        }
        if let data = try? Data(contentsOf: dbFileURL),
           let arr = try? JSONSerialization.jsonObject(with: data, options: []) as? [[String: Any]] {
            return arr
        }
        return []
    }
    
    func saveUsers(_ users: [[String: Any]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: users, options: []),
              let str = String(data: data, encoding: .utf8) else { return }
        saveKeychainString(str, account: "miruo_users_db_v1")
        try? data.write(to: dbFileURL, options: .atomic)
    }
    
    func findExistingAppleUser(userIdentifier: String, email: String) -> [String: Any]? {
        let users = loadUsers()
        let canonicalId = userIdentifier.hasPrefix("apple_") ? userIdentifier : "apple_\(userIdentifier)"
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return users.first { u in
            let uid = (u["id"] as? String) ?? ""
            let aid = (u["appleUserId"] as? String) ?? ""
            let uemail = ((u["email"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !userIdentifier.isEmpty && (uid == canonicalId || uid == userIdentifier || aid == userIdentifier || aid == canonicalId) {
                return true
            }
            if !cleanEmail.isEmpty && uemail == cleanEmail {
                return true
            }
            return false
        }
    }
    
    func handleAuthEndpoint(path: String, method: String, bodyString: String) -> (Int, [String: Any]) {
        return queue.sync {
            let bodyData = bodyString.data(using: .utf8) ?? Data()
            let body = (try? JSONSerialization.jsonObject(with: bodyData, options: []) as? [String: Any]) ?? [:]
            var users = loadUsers()
            
            if path == "/api/auth/social-sync" && method == "POST" {
                let rawId = ((body["id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let appleUserId = ((body["appleUserId"] as? String) ?? rawId).replacingOccurrences(of: "apple_", with: "")
                let email = ((body["email"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let reqUsername = ((body["username"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let displayName = ((body["displayName"] as? String) ?? (body["fullName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let provider = ((body["provider"] as? String) ?? "Apple").trimmingCharacters(in: .whitespacesAndNewlines)
                let avatarUrl = body["avatarUrl"] as? String
                let avatarBg = body["avatarBg"] as? String
                
                let canonicalId = !rawId.isEmpty ? rawId : (!appleUserId.isEmpty ? "apple_\(appleUserId)" : "usr_\(Int(Date().timeIntervalSince1970))")
                
                if let idx = users.firstIndex(where: { u in
                    let uid = (u["id"] as? String) ?? ""
                    let aid = (u["appleUserId"] as? String) ?? ""
                    let uemail = ((u["email"] as? String) ?? "").lowercased()
                    if !canonicalId.isEmpty && (uid == canonicalId || (!appleUserId.isEmpty && (uid == appleUserId || aid == appleUserId))) {
                        return true
                    }
                    if !email.isEmpty && uemail == email {
                        return true
                    }
                    return false
                }) {
                    var existing = users[idx]
                    // Preserve existing user's customized fullName, username, avatarUrl, avatarBg!
                    if ((existing["fullName"] as? String) ?? "").isEmpty && !displayName.isEmpty {
                        existing["fullName"] = displayName
                    }
                    if ((existing["email"] as? String) ?? "").isEmpty && !email.isEmpty {
                        existing["email"] = email
                    }
                    if !appleUserId.isEmpty {
                        existing["appleUserId"] = appleUserId
                    }
                    if ((existing["avatarUrl"] as? String) ?? "").isEmpty, let av = avatarUrl, !av.isEmpty {
                        existing["avatarUrl"] = av
                    }
                    if ((existing["avatarBg"] as? String) ?? "").isEmpty, let bg = avatarBg, !bg.isEmpty {
                        existing["avatarBg"] = bg
                    }
                    users[idx] = existing
                    saveUsers(users)
                    return (200, [
                        "ok": true,
                        "isExistingUser": true,
                        "token": "local_tok_\(existing["id"] as? String ?? canonicalId)",
                        "user": existing
                    ])
                } else {
                    let finalName = !displayName.isEmpty ? displayName : (!reqUsername.isEmpty ? reqUsername : (email.components(separatedBy: "@").first ?? "Apple Kullanıcısı"))
                    var baseUsername = !reqUsername.isEmpty ? reqUsername : (email.components(separatedBy: "@").first ?? finalName)
                    baseUsername = baseUsername.lowercased().replacingOccurrences(of: "[^a-z0-9_.]", with: "", options: .regularExpression)
                    if baseUsername.count < 3 { baseUsername = "user_\(Int.random(in: 1000...9999))" }
                    if users.contains(where: { (($0["username"] as? String) ?? "").lowercased() == baseUsername }) {
                        baseUsername = "\(baseUsername)\(Int.random(in: 10...999))"
                    }
                    let newUser: [String: Any] = [
                        "id": canonicalId,
                        "appleUserId": appleUserId,
                        "fullName": finalName,
                        "username": baseUsername,
                        "email": email,
                        "provider": provider,
                        "avatarUrl": avatarUrl ?? "",
                        "avatarBg": avatarBg ?? "linear-gradient(135deg, #ec4899, #8b5cf6)",
                        "createdAt": ISO8601DateFormatter().string(from: Date())
                    ]
                    users.append(newUser)
                    saveUsers(users)
                    return (200, [
                        "ok": true,
                        "isExistingUser": false,
                        "token": "local_tok_\(canonicalId)",
                        "user": newUser
                    ])
                }
            }
            
            if path == "/api/auth/register" && method == "POST" {
                let fullName = ((body["fullName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let username = ((body["username"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let email = ((body["email"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let password = (body["password"] as? String) ?? ""
                
                if !email.isEmpty && users.contains(where: { (($0["email"] as? String) ?? "").lowercased() == email }) {
                    return (409, ["error": "Bu e-posta adresi ile zaten kayıtlı bir hesap bulunuyor. Lütfen giriş yapın."])
                }
                if !username.isEmpty && users.contains(where: { (($0["username"] as? String) ?? "").lowercased() == username }) {
                    return (409, ["error": "Bu kullanıcı adı zaten alınmış."])
                }
                let uid = "usr_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 100...999))"
                let newUser: [String: Any] = [
                    "id": uid,
                    "fullName": fullName,
                    "username": username,
                    "email": email,
                    "password": password,
                    "provider": "local",
                    "avatarUrl": (body["avatarUrl"] as? String) ?? "",
                    "avatarBg": (body["avatarBg"] as? String) ?? "linear-gradient(135deg, #ec4899, #8b5cf6)",
                    "createdAt": ISO8601DateFormatter().string(from: Date())
                ]
                users.append(newUser)
                saveUsers(users)
                return (200, ["ok": true, "token": "local_tok_\(uid)", "user": newUser])
            }
            
            if path == "/api/auth/login" && method == "POST" {
                let identifier = ((body["identifier"] as? String) ?? (body["email"] as? String) ?? (body["username"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let password = (body["password"] as? String) ?? ""
                if let found = users.first(where: {
                    let uemail = (($0["email"] as? String) ?? "").lowercased()
                    let uname = (($0["username"] as? String) ?? "").lowercased()
                    return (uemail == identifier || uname == identifier) && (($0["password"] as? String) ?? password) == password
                }) {
                    return (200, ["ok": true, "token": "local_tok_\(found["id"] as? String ?? "")", "user": found])
                }
                return (401, ["error": "Kullanıcı bulunamadı veya şifre hatalı."])
            }
            
            if path == "/api/auth/update-profile" && method == "POST" {
                let userId = ((body["id"] as? String) ?? (body["userId"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let email = ((body["email"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let rawAppleSub = ((body["appleUserId"] as? String) ?? userId).replacingOccurrences(of: "apple_", with: "")
                if let idx = users.firstIndex(where: {
                    let uid = ($0["id"] as? String) ?? ""
                    let aid = ($0["appleUserId"] as? String) ?? ""
                    let uemail = (($0["email"] as? String) ?? "").lowercased()
                    return (!userId.isEmpty && uid == userId) || (!email.isEmpty && uemail == email) || (!rawAppleSub.isEmpty && (uid == rawAppleSub || aid == rawAppleSub))
                }) {
                    var u = users[idx]
                    if let fn = body["fullName"] as? String, !fn.isEmpty { u["fullName"] = fn }
                    if let un = body["username"] as? String, !un.isEmpty { u["username"] = un.lowercased() }
                    if let av = body["avatarUrl"] as? String { u["avatarUrl"] = av }
                    if let bg = body["avatarBg"] as? String, !bg.isEmpty { u["avatarBg"] = bg }
                    users[idx] = u
                    saveUsers(users)
                    
                    if !rawAppleSub.isEmpty {
                        if let fn = u["fullName"] as? String, !fn.isEmpty {
                            UserDefaults.standard.set(fn, forKey: "apple_user_fullname_\(rawAppleSub)")
                            saveKeychainString(fn, account: "apple_fullname_\(rawAppleSub)")
                            saveKeychainString(fn, account: "miruo_custom_fullname_\(rawAppleSub)")
                        }
                        if let un = u["username"] as? String, !un.isEmpty {
                            saveKeychainString(un, account: "miruo_custom_username_\(rawAppleSub)")
                        }
                        if let av = u["avatarUrl"] as? String, !av.isEmpty {
                            saveKeychainString(av, account: "miruo_custom_avatar_\(rawAppleSub)")
                        }
                    }
                    return (200, ["ok": true, "success": true, "user": u])
                }
                return (200, ["ok": true, "success": true])
            }
            
            if path == "/api/auth/delete-account" && method == "POST" {
                let userId = ((body["userId"] as? String) ?? (body["id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let email = ((body["email"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let rawAppleSub = ((body["appleUserId"] as? String) ?? userId).replacingOccurrences(of: "apple_", with: "")
                users.removeAll(where: {
                    let uid = ($0["id"] as? String) ?? ""
                    let aid = ($0["appleUserId"] as? String) ?? ""
                    let uemail = (($0["email"] as? String) ?? "").lowercased()
                    return (!userId.isEmpty && uid == userId) || (!email.isEmpty && uemail == email) || (!rawAppleSub.isEmpty && (uid == rawAppleSub || aid == rawAppleSub))
                })
                saveUsers(users)
                if !rawAppleSub.isEmpty {
                    UserDefaults.standard.removeObject(forKey: "apple_user_fullname_\(rawAppleSub)")
                    UserDefaults.standard.removeObject(forKey: "apple_user_email_\(rawAppleSub)")
                    deleteKeychainItem(account: "apple_fullname_\(rawAppleSub)")
                    deleteKeychainItem(account: "apple_email_\(rawAppleSub)")
                    deleteKeychainItem(account: "miruo_custom_fullname_\(rawAppleSub)")
                    deleteKeychainItem(account: "miruo_custom_username_\(rawAppleSub)")
                    deleteKeychainItem(account: "miruo_custom_avatar_\(rawAppleSub)")
                }
                return (200, ["ok": true, "success": true, "message": "Hesabınız başarıyla silindi."])
            }
            
            return (200, ["ok": true])
        }
    }
}

// MARK: - Native Photo Gallery & Image Picker Bridge
extension ViewController: PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    @available(iOS 14, *)
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let result = results.first else { return }
        let provider = result.itemProvider
        
        if provider.hasItemConformingToTypeIdentifier("public.movie") {
            provider.loadFileRepresentation(forTypeIdentifier: "public.movie") { [weak self] url, error in
                guard let url = url, let self = self else { return }
                let tempDir = FileManager.default.temporaryDirectory
                let destUrl = tempDir.appendingPathComponent(url.lastPathComponent)
                try? FileManager.default.removeItem(at: destUrl)
                do {
                    try FileManager.default.copyItem(at: url, to: destUrl)
                    let js = "if (typeof window.handleNativeVideoPicked === 'function') { window.handleNativeVideoPicked('\(destUrl.absoluteString)', '\(destUrl.lastPathComponent)'); }"
                    DispatchQueue.main.async {
                        self.webView.evaluateJavaScript(js, completionHandler: nil)
                    }
                } catch {
                    print("[Miruo] Error copying video: \(error)")
                }
            }
            return
        }

        if provider.canLoadObject(ofClass: UIImage.self) {
            provider.loadObject(ofClass: UIImage.self) { [weak self] (object, error) in
                if let image = object as? UIImage {
                    self?.processAndSendPickedImage(image)
                } else {
                    self?.loadDataRepresentation(from: provider)
                }
            }
        } else {
            self.loadDataRepresentation(from: provider)
        }
    }
    
    private func loadDataRepresentation(from provider: NSItemProvider) {
        if #available(iOS 14.0, *) {
            provider.loadDataRepresentation(forTypeIdentifier: "public.image") { [weak self] (data, error) in
                if let data = data, let image = UIImage(data: data) {
                    self?.processAndSendPickedImage(image)
                }
            }
        }
    }
    
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        picker.dismiss(animated: true)
        if let videoUrl = info[.mediaURL] as? URL {
            let js = "if (typeof window.handleNativeVideoPicked === 'function') { window.handleNativeVideoPicked('\(videoUrl.absoluteString)', '\(videoUrl.lastPathComponent)'); }"
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
            return
        }
        if let image = (info[.editedImage] as? UIImage) ?? (info[.originalImage] as? UIImage) {
            processAndSendPickedImage(image)
        }
    }
    
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }
    
    private func processAndSendPickedImage(_ image: UIImage) {
        let maxDim: CGFloat = 1024
        let size = image.size
        var newSize = size
        if size.width > maxDim || size.height > maxDim {
            let ratio = min(maxDim / size.width, maxDim / size.height)
            newSize = CGSize(width: size.width * ratio, height: size.height * ratio)
        }
        
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
        let resizedImage = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
        
        guard let data = resizedImage.jpegData(compressionQuality: 0.8) else { return }
        let base64String = data.base64EncodedString()
        let dataUri = "data:image/jpeg;base64,\(base64String)"
        
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let js = "if (typeof window.handleNativeImagePicked === 'function') { window.handleNativeImagePicked('\(dataUri)', '\(self.currentImagePickTarget)'); }"
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

// MARK: - Native Apple Sign In Delegate (ASAuthorizationController)
extension ViewController: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.view.window ?? UIWindow()
    }
    
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential {
            var userIdentifier = appleIDCredential.user
            var email = appleIDCredential.email ?? ""
            var fullName = [appleIDCredential.fullName?.givenName, appleIDCredential.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            
            var identityTokenString = ""
            if let identityTokenData = appleIDCredential.identityToken,
               let token = String(data: identityTokenData, encoding: .utf8) {
                identityTokenString = token
                if let jwtClaims = MiruoPersistentAuthStore.shared.decodeJwtPayload(token) {
                    if email.isEmpty, let jwtEmail = jwtClaims["email"] as? String, !jwtEmail.isEmpty {
                        email = jwtEmail
                    }
                    if userIdentifier.isEmpty, let jwtSub = jwtClaims["sub"] as? String, !jwtSub.isEmpty {
                        userIdentifier = jwtSub
                    }
                }
            }
            
            let store = MiruoPersistentAuthStore.shared
            // Persist & recover fullName and email in iOS Keychain + UserDefaults across reinstalls
            // If the user previously set a custom profile name, ALWAYS prioritize custom profile name!
            let customSavedName = store.loadKeychainString(account: "miruo_custom_fullname_\(userIdentifier)")
            let customSavedUsername = store.loadKeychainString(account: "miruo_custom_username_\(userIdentifier)")
            let customSavedAvatar = store.loadKeychainString(account: "miruo_custom_avatar_\(userIdentifier)")

            if let custom = customSavedName, !custom.isEmpty {
                fullName = custom
            } else if !fullName.isEmpty {
                UserDefaults.standard.set(fullName, forKey: "apple_user_fullname_\(userIdentifier)")
                store.saveKeychainString(fullName, account: "apple_fullname_\(userIdentifier)")
            } else {
                fullName = store.loadKeychainString(account: "apple_fullname_\(userIdentifier)")
                    ?? UserDefaults.standard.string(forKey: "apple_user_fullname_\(userIdentifier)")
                    ?? ""
            }
            if !email.isEmpty {
                UserDefaults.standard.set(email, forKey: "apple_user_email_\(userIdentifier)")
                store.saveKeychainString(email, account: "apple_email_\(userIdentifier)")
            } else {
                email = store.loadKeychainString(account: "apple_email_\(userIdentifier)")
                    ?? UserDefaults.standard.string(forKey: "apple_user_email_\(userIdentifier)")
                    ?? ""
            }
            
            // Check if this Apple account is already registered in persistent store
            if var existingUser = store.findExistingAppleUser(userIdentifier: userIdentifier, email: email) {
                if let custom = customSavedName, !custom.isEmpty {
                    existingUser["fullName"] = custom
                    fullName = custom
                } else if fullName.isEmpty, let savedName = existingUser["fullName"] as? String, !savedName.isEmpty {
                    fullName = savedName
                }
                if let customU = customSavedUsername, !customU.isEmpty {
                    existingUser["username"] = customU
                }
                if let customA = customSavedAvatar, !customA.isEmpty {
                    existingUser["avatarUrl"] = customA
                }
                if email.isEmpty, let savedEmail = existingUser["email"] as? String, !savedEmail.isEmpty {
                    email = savedEmail
                }
            }
            
            var authCodeString = ""
            if let authCodeData = appleIDCredential.authorizationCode,
               let code = String(data: authCodeData, encoding: .utf8) {
                authCodeString = code
            }
            
            var payload: [String: Any] = [
                "success": true,
                "userIdentifier": userIdentifier,
                "email": email,
                "fullName": fullName,
                "identityToken": identityTokenString,
                "authorizationCode": authCodeString
            ]
            if let existingUser = store.findExistingAppleUser(userIdentifier: userIdentifier, email: email) {
                payload["existingUser"] = existingUser
            }
            
            if let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                let js = "if (typeof window.handleNativeAppleSignInResponse === 'function') { window.handleNativeAppleSignInResponse(\(jsonString)); }"
                DispatchQueue.main.async { [weak self] in
                    self?.webView.evaluateJavaScript(js, completionHandler: nil)
                }
            }
        }
    }
    
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let authError = error as? ASAuthorizationError
        let isCanceled = (authError?.code == .canceled) || (error as NSError).code == 1001
        let payload: [String: Any] = [
            "success": false,
            "canceled": isCanceled,
            "error": isCanceled ? "canceled" : error.localizedDescription
        ]
        if let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            let js = "if (typeof window.handleNativeAppleSignInResponse === 'function') { window.handleNativeAppleSignInResponse(\(jsonString)); }"
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
}

// MARK: - Native Web Authentication Session (ASWebAuthenticationSession - Google OAuth)
extension ViewController: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return self.view.window ?? UIWindow()
    }
}
