import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }
        
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = ViewController()
        self.window = window
        window.makeKeyAndVisible()
    }

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func sceneDidDisconnect(_ scene: UIScene) {}
    func sceneDidBecomeActive(_ scene: UIScene) {}
    func sceneWillResignActive(_ scene: UIScene) {}

    func sceneWillEnterForeground(_ scene: UIScene) {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        if let vc = window?.rootViewController as? ViewController {
            vc.handleAppForeground()
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // Continuous background execution for screen sharing, media and WebRTC room connection
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "MiruoScreenShareContinuous") { [weak self] in
            if let task = self?.backgroundTask, task != .invalid {
                UIApplication.shared.endBackgroundTask(task)
                self?.backgroundTask = .invalid
            }
        }
        if let vc = window?.rootViewController as? ViewController {
            vc.handleAppBackground()
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        if let vc = window?.rootViewController as? ViewController {
            vc.handleDeepLink(url)
        }
    }
}
