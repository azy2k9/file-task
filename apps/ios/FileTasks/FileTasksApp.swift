import SwiftUI
import UIKit
import UserNotifications

@main
struct FileTasksApp: App {
    @UIApplicationDelegateAdaptor(PushRegistrationDelegate.self) private var pushRegistrationDelegate
    @StateObject private var settings: APISettings
    @StateObject private var model: AppModel

    init() {
        let settings = APISettings()
        _settings = StateObject(wrappedValue: settings)
        _model = StateObject(wrappedValue: AppModel(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(model)
        }
    }
}

final class PushRegistrationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let tokenNotification = Notification.Name("FileTasksAPNSToken")
    static var pendingItemId: String?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: Self.tokenNotification, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: Self.tokenNotification, object: error)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let itemId = response.notification.request.content.userInfo["itemId"] as? String {
            Self.pendingItemId = itemId
            NotificationCenter.default.post(name: .fileTasksPushItem, object: itemId)
        }
        completionHandler()
    }
}

extension Notification.Name {
    static let fileTasksPushItem = Notification.Name("FileTasksPushItem")
}
