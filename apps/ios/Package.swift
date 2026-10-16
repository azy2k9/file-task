// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FileTasksNativeAcceptance",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FileTasksNativeAcceptanceClient", targets: ["FileTasksNativeAcceptanceClient"]),
    ],
    targets: [
        .target(
            name: "FileTasksNativeAcceptanceClient",
            path: "FileTasks",
            exclude: ["FileTasksApp.swift", "Info.plist", "FileTasks.entitlements", "Security", "State", "Views", "Networking/APISettings.swift"],
            sources: ["Domain/WorkspaceItem.swift", "Networking/APIClient.swift"]
        ),
        .testTarget(
            name: "FileTasksNativeAcceptanceTests",
            dependencies: ["FileTasksNativeAcceptanceClient"],
            path: "AcceptanceTests"
        ),
    ]
)
