import UIKit
import WebKit
import Network
import AVFoundation
import PhotosUI
import AuthenticationServices

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
            try session.setCategory(.playAndRecord, mode: .moviePlayback, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowAirPlay])
            try session.setActive(true)
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
        loadingLabel.text = "Miruo Bağlanıyor..."
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
        
        showErrorUI(message: "Uygulama arayüz dosyaları bulunamadı.")
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
        let testView = ProcessInfo.processInfo.environment["MIRUO_VIEW"]
        if let view = testView {
            queryParts.append("view=\(view)")
        }
        let testLang = ProcessInfo.processInfo.environment["MIRUO_LANG"]
        if let lang = testLang {
            queryParts.append("lang=\(lang)")
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
        iconLabel.text = "✨"
        iconLabel.font = UIFont.systemFont(ofSize: 42)
        
        let titleLabel = UILabel()
        titleLabel.text = "Miruo Yeniden Yükleniyor"
        titleLabel.textColor = .white
        titleLabel.font = UIFont.systemFont(ofSize: 18, weight: .bold)
        
        let descLabel = UILabel()
        descLabel.text = "Arayüz yüklenirken bir gecikme oluştu. Yenile butonuna basarak anında başlatabilirsiniz."
        descLabel.textColor = UIColor(white: 0.75, alpha: 1.0)
        descLabel.font = UIFont.systemFont(ofSize: 12, weight: .regular)
        descLabel.textAlignment = .center
        descLabel.numberOfLines = 0
        
        let retryBtn = UIButton(type: .system)
        retryBtn.setTitle("🔄 Tekrar Dene", for: .normal)
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
        let alert = UIAlertController(
            title: "🌐 Miruo Sunucu Ayarı",
            message: "Bilgisayarınızın IP adresini girin (Aynı Wi-Fi ağında olmalıdır):",
            preferredStyle: .alert
        )
        
        alert.addTextField { tf in
            tf.placeholder = "http://192.168.1.20:3000"
            tf.text = current
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.clearButtonMode = .whileEditing
        }
        
        alert.addAction(UIAlertAction(title: "Güncel IP (192.168.1.20)", style: .default) { [weak self] _ in
            UserDefaults.standard.set("http://192.168.1.20:3000", forKey: "miruo_url")
            self?.loadPage()
        })
        
        alert.addAction(UIAlertAction(title: "Localhost (Simülatör)", style: .default) { [weak self] _ in
            UserDefaults.standard.set("http://localhost:3000", forKey: "miruo_url")
            self?.loadPage()
        })
        
        alert.addAction(UIAlertAction(title: "Kaydet ve Bağlan", style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            UserDefaults.standard.set(text, forKey: "miruo_url")
            self?.loadPage()
        })
        
        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        present(alert, animated: true)
    }
    
    // WKScriptMessageHandler: JS calls window.webkit.messageHandlers.openYouTube / openPlatform
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "openYouTube" {
            openInAppPlatformBrowser(provider: "youtube", initialUrl: "https://m.youtube.com/feed/trending", title: "YouTube")
        } else if message.name == "openPlatform" {
            if let dict = message.body as? [String: Any] {
                let provider = dict["provider"] as? String ?? "youtube"
                let url = dict["url"] as? String ?? "https://m.youtube.com/feed/trending"
                let title = dict["title"] as? String ?? "Tarayıcı"
                openInAppPlatformBrowser(provider: provider, initialUrl: url, title: title)
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
    
    private func openNativeImagePicker() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            var topController: UIViewController = self
            while let presented = topController.presentedViewController, !presented.isBeingDismissed {
                topController = presented
            }
            
            if #available(iOS 14, *) {
                var config = PHPickerConfiguration()
                config.filter = .images
                config.selectionLimit = 1
                let picker = PHPickerViewController(configuration: config)
                picker.delegate = self
                picker.modalPresentationStyle = .pageSheet
                topController.present(picker, animated: true)
            } else {
                let picker = UIImagePickerController()
                picker.sourceType = .photoLibrary
                picker.delegate = self
                topController.present(picker, animated: true)
            }
        }
    }
    
    private func openInAppPlatformBrowser(provider: String, initialUrl: String, title: String) {
        let browserVC = PlatformBrowserViewController()
        browserVC.provider = provider
        browserVC.initialUrl = initialUrl
        browserVC.browserTitle = title
        browserVC.onVideoSelected = { [weak self] videoIdOrUrl in
            let escapedId = videoIdOrUrl.replacingOccurrences(of: "'", with: "\\'")
            let js = "window.MiruoBridge && window.MiruoBridge.loadVideo('\(escapedId)');"
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
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
            let js = "setTimeout(() => { document.getElementById('roomQuickSearchBtn')?.click(); }, 1200);"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        if let _ = ProcessInfo.processInfo.environment["OPEN_QUEUE"] {
            let js = "setTimeout(() => { document.getElementById('roomQueueBadgeBtn')?.click(); }, 1200);"
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
}

// Full-Featured In-App Browser for YouTube, Netflix, Prime, Disney+, Twitch, Web, etc.
class PlatformBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UISearchBarDelegate {
    var provider: String = "youtube"
    var initialUrl: String = "https://m.youtube.com/feed/trending"
    var browserTitle: String = "YouTube"
    var onVideoSelected: ((String) -> Void)?
    
    private var webView: WKWebView!
    private var searchBar: UISearchBar!
    private var progressView: UIProgressView!
    private var progressObservation: NSKeyValueObservation?
    
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
        
        let backItem = UIBarButtonItem(title: "←", style: .plain, target: self, action: #selector(backTapped))
        backItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 20)], for: .normal)
        
        let forwardItem = UIBarButtonItem(title: "→", style: .plain, target: self, action: #selector(forwardTapped))
        forwardItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 20)], for: .normal)
        
        let reloadItem = UIBarButtonItem(title: "⟳", style: .plain, target: self, action: #selector(reloadTapped))
        reloadItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 18)], for: .normal)
        
        navigationItem.leftBarButtonItems = [backItem, forwardItem, reloadItem]
        
        let closeItem = UIBarButtonItem(title: "✕", style: .done, target: self, action: #selector(closeTapped))
        closeItem.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 18), .foregroundColor: UIColor.systemRed], for: .normal)
        navigationItem.rightBarButtonItem = closeItem
        
        searchBar = UISearchBar()
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal
        searchBar.autocapitalizationType = .none
        searchBar.autocorrectionType = .no
        
        if provider == "youtube" {
            searchBar.placeholder = "YouTube'da ara..."
        } else if provider == "twitch" {
            searchBar.placeholder = "Twitch'te yayın ara..."
        } else if provider == "netflix" {
            searchBar.placeholder = "Netflix'te ara..."
        } else {
            searchBar.placeholder = "Ara veya link yaz..."
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
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        
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
        let bottomBar = UIView()
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.backgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.14, alpha: 0.98)
        bottomBar.layer.borderWidth = 0.5
        bottomBar.layer.borderColor = UIColor(white: 0.2, alpha: 1.0).cgColor
        view.addSubview(bottomBar)
        
        let syncBtn = UIButton(type: .system)
        syncBtn.translatesAutoresizingMaskIntoConstraints = false
        syncBtn.setTitle("▶ Bu Videoyu Odaya Aktar ve İzle", for: .normal)
        syncBtn.setTitleColor(.white, for: .normal)
        syncBtn.titleLabel?.font = UIFont.boldSystemFont(ofSize: 13)
        syncBtn.backgroundColor = UIColor(red: 0.88, green: 0.12, blue: 0.28, alpha: 1.0)
        syncBtn.layer.cornerRadius = 14
        syncBtn.addTarget(self, action: #selector(syncCurrentContentTapped), for: .touchUpInside)
        bottomBar.addSubview(syncBtn)
        
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
            case "netflix":
                targetStr = "https://www.netflix.com/search?q=\(encoded)"
            default:
                targetStr = "https://www.google.com/search?q=\(encoded)"
            }
            if let u = URL(string: targetStr) {
                webView.load(URLRequest(url: u))
            }
        }
    }
    
    @objc private func backTapped() {
        if webView.canGoBack {
            webView.goBack()
        } else {
            dismiss(animated: true)
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
        dismiss(animated: true)
    }
    
    @objc private func syncCurrentContentTapped() {
        guard let currentUrl = webView.url else { return }
        let urlStr = currentUrl.absoluteString
        let videoId = extractYouTubeId(urlString: urlStr) ?? urlStr
        dismiss(animated: true) { [weak self] in
            self?.onVideoSelected?(videoId)
        }
    }
    
    // WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "videoIntercepted", let videoId = message.body as? String, !videoId.isEmpty {
            dismiss(animated: true) { [weak self] in
                self?.onVideoSelected?(videoId)
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
            dismiss(animated: true) { [weak self] in
                self?.onVideoSelected?(videoId)
            }
            return
        }
        
        decisionHandler(.allow)
    }
    
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let current = webView.url?.absoluteString {
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
        alert.addAction(UIAlertAction(title: "Tamam", style: .default) { _ in completionHandler() })
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
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] content, _, _, _ in
            guard let self = self, let content = content, let requestString = String(data: content, encoding: .utf8) else {
                connection.cancel()
                return
            }
            
            let firstLine = requestString.components(separatedBy: "\r\n").first ?? ""
            let parts = firstLine.components(separatedBy: " ")
            guard parts.count >= 2, parts[0] == "GET" else {
                self.sendResponse(connection: connection, statusCode: 400, contentType: "text/plain", data: Data("Bad Request".utf8))
                return
            }
            
            var path = parts[1]
            if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
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
        var header = "HTTP/1.1 \(statusCode) \(statusCode == 200 ? "OK" : "Not Found")\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(data.count)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
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

// MARK: - Native Photo Gallery & Image Picker Bridge
extension ViewController: PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    @available(iOS 14, *)
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let result = results.first else { return }
        let provider = result.itemProvider
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
            let userIdentifier = appleIDCredential.user
            var email = appleIDCredential.email ?? ""
            var fullName = [appleIDCredential.fullName?.givenName, appleIDCredential.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
            
            // Cache full name and email in UserDefaults because Apple only sends them on the first authorization
            if !fullName.isEmpty {
                UserDefaults.standard.set(fullName, forKey: "apple_user_fullname_\(userIdentifier)")
            } else {
                fullName = UserDefaults.standard.string(forKey: "apple_user_fullname_\(userIdentifier)") ?? ""
            }
            if !email.isEmpty {
                UserDefaults.standard.set(email, forKey: "apple_user_email_\(userIdentifier)")
            } else {
                email = UserDefaults.standard.string(forKey: "apple_user_email_\(userIdentifier)") ?? ""
            }
            
            var identityTokenString = ""
            if let identityTokenData = appleIDCredential.identityToken,
               let token = String(data: identityTokenData, encoding: .utf8) {
                identityTokenString = token
            }
            
            var authCodeString = ""
            if let authCodeData = appleIDCredential.authorizationCode,
               let code = String(data: authCodeData, encoding: .utf8) {
                authCodeString = code
            }
            
            let payload: [String: Any] = [
                "success": true,
                "userIdentifier": userIdentifier,
                "email": email,
                "fullName": fullName,
                "identityToken": identityTokenString,
                "authorizationCode": authCodeString
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
