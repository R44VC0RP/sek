// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sek",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "sek", path: "Sources/sek"),
    ]
)
