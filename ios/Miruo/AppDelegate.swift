import UIKit
import AVFoundation

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .moviePlayback, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowAirPlay])
            try audioSession.setActive(true)
        } catch {
            print("AppDelegate AVAudioSession error: \(error)")
        }
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        backgroundTask = application.beginBackgroundTask(withName: "MiruoContinuousStream") { [weak self] in
            if let task = self?.backgroundTask, task != .invalid {
                application.endBackgroundTask(task)
                self?.backgroundTask = .invalid
            }
        }
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        if backgroundTask != .invalid {
            application.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    // MARK: UISceneSession Lifecycle
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    func application(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>) {}
}
