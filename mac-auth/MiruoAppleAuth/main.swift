import Cocoa
import AuthenticationServices
import Security

func saveToKeychain(key: String, value: String) {
    guard let data = value.data(using: .utf8) else { return }
    let service = "com.miruo.app.appleauth"
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key
    ]
    SecItemDelete(query as CFDictionary)
    var addQuery = query
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(addQuery as CFDictionary, nil)
}

func readFromKeychain(key: String) -> String? {
    let service = "com.miruo.app.appleauth"
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
}

func decodeJWTPayload(_ token: String) -> [String: Any]? {
    let segments = token.components(separatedBy: ".")
    guard segments.count > 1 else { return nil }
    var base64 = segments[1]
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 {
        base64.append("=")
    }
    guard let data = Data(base64Encoded: base64),
          let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
        return nil
    }
    return json
}

func emitJSONAndExit(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
       let str = String(data: data, encoding: .utf8) {
        print("MIRUO_APPLE_AUTH_JSON:\(str)")
        fflush(stdout)
    }
    exit(0)
}

class AuthAppDelegate: NSObject, NSApplicationDelegate, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let winWidth: CGFloat = 420
        let winHeight: CGFloat = 340
        let originX = screenRect.origin.x + (screenRect.size.width - winWidth) / 2.0
        let originY = screenRect.origin.y + (screenRect.size.height - winHeight) / 2.0

        window = NSWindow(
            contentRect: NSRect(x: originX, y: originY, width: winWidth, height: winHeight),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            let provider = ASAuthorizationAppleIDProvider()
            let request = provider.createRequest()
            request.requestedScopes = [.fullName, .email]

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return window
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            emitJSONAndExit(["success": false, "error": "Invalid credential type"])
            return
        }

        let userIdentifier = appleIDCredential.user
        var identityTokenString = ""
        if let tokenData = appleIDCredential.identityToken,
           let tokenStr = String(data: tokenData, encoding: .utf8) {
            identityTokenString = tokenStr
        }

        var authCodeString = ""
        if let codeData = appleIDCredential.authorizationCode,
           let codeStr = String(data: codeData, encoding: .utf8) {
            authCodeString = codeStr
        }

        let jwtClaims = decodeJWTPayload(identityTokenString)
        let jwtEmail = (jwtClaims?["email"] as? String) ?? ""

        var email = (appleIDCredential.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if email.isEmpty && !jwtEmail.isEmpty {
            email = jwtEmail
        }
        if !email.isEmpty {
            saveToKeychain(key: "email_\(userIdentifier)", value: email)
            saveToKeychain(key: "last_apple_email", value: email)
            UserDefaults.standard.set(email, forKey: "apple_user_email_\(userIdentifier)")
        } else {
            email = readFromKeychain(key: "email_\(userIdentifier)")
                ?? UserDefaults.standard.string(forKey: "apple_user_email_\(userIdentifier)")
                ?? readFromKeychain(key: "last_apple_email")
                ?? ""
        }

        var fullName = [appleIDCredential.fullName?.givenName, appleIDCredential.fullName?.familyName]
            .compactMap { $0 }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if !fullName.isEmpty {
            saveToKeychain(key: "fullname_\(userIdentifier)", value: fullName)
            saveToKeychain(key: "last_apple_fullname", value: fullName)
            UserDefaults.standard.set(fullName, forKey: "apple_user_fullname_\(userIdentifier)")
        } else {
            fullName = readFromKeychain(key: "fullname_\(userIdentifier)")
                ?? UserDefaults.standard.string(forKey: "apple_user_fullname_\(userIdentifier)")
                ?? readFromKeychain(key: "last_apple_fullname")
                ?? ""
        }

        emitJSONAndExit([
            "success": true,
            "userIdentifier": userIdentifier,
            "email": email,
            "fullName": fullName,
            "identityToken": identityTokenString,
            "authorizationCode": authCodeString
        ])
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let authError = error as? ASAuthorizationError
        let nsErr = error as NSError
        let isCanceled = (authError?.code == .canceled) || nsErr.code == 1001
        emitJSONAndExit([
            "success": false,
            "canceled": isCanceled,
            "error": isCanceled ? "canceled" : error.localizedDescription
        ])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AuthAppDelegate()
app.delegate = delegate
app.run()
